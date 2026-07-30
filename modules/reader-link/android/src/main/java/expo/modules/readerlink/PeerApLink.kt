package expo.modules.readerlink

import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.SystemClock
import java.net.Inet4Address
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * PeerApLink — joins the reader's soft AP as a PEER, keeping the phone's default route where it
 * was.
 *
 * THE RECIPE IS THE DOCUMENTED ONE, not an invention. From
 * https://developer.android.com/develop/connectivity/wifi/wifi-bootstrap
 * ("Wi-Fi Network Request API for peer-to-peer connectivity", API 29+):
 *
 *     val request = NetworkRequest.Builder()
 *         .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
 *         .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
 *         .setNetworkSpecifier(specifier)
 *         .build()
 *     connectivityManager.requestNetwork(request, networkCallback)
 *     // Release the request when done.
 *     connectivityManager.unregisterNetworkCallback(networkCallback)
 *
 * and the two notes from that same page that shape everything below:
 *   - "Always call unregisterNetworkCallback() when done; the network is torn down when the
 *     callback is unregistered."  -> the link's lifetime IS the callback's lifetime. There is no
 *     other handle to release, so a leaked callback is a Wi-Fi association the user cannot get
 *     rid of without force-stopping the app.
 *   - "This network is not the default route; use bindSocket() or Network.openConnection() to
 *     utilize it."  -> nothing reaches the reader unless it is bound to THIS Network object,
 *     and `removeCapability(NET_CAPABILITY_INTERNET)` is why the peer link can never become the
 *     process default and steal the app's mailbox traffic.
 *
 * NO SCANNING. A3 is explicit that `WifiManager.startScan()` is throttled (4 scans / 2 min
 * foreground, 1 / 30 min background) and the reader's AP window is ~45 s, so a scanning watcher
 * can miss the window outright. The platform's own matching against an outstanding request is
 * the mechanism; `timeoutMs = 0` keeps the request outstanding for exactly that reason.
 *
 * LEAK DISCIPLINE (the failure mode A3 calls out): a request that is never granted must not
 * leave a live callback behind.
 *   - onUnavailable: the platform has ALREADY released the request. Verified in AOSP's
 *     ConnectivityManager.CallbackHandler: on CALLBACK_UNAVAIL it does
 *     `sCallbacks.remove(request); callback.networkRequest = ALREADY_UNREGISTERED`, and
 *     unregisterNetworkCallback() early-returns for ALREADY_UNREGISTERED (it only throws
 *     IllegalArgumentException for a callback that was never registered). [release] is
 *     therefore idempotent and still wrapped in a catch.
 *   - timeout / cancel / JS reload: [release] runs from the ops path AND from
 *     `OnDestroy` in the module, so a Metro reload cannot orphan the association.
 */
internal class PeerApLink(
  private val cm: ConnectivityManager,
  private val emitLinkState: (Map<String, Any?>) -> Unit,
  private val onLinkLost: (String) -> Unit
) {
  private val lock = Any()
  private var callback: ConnectivityManager.NetworkCallback? = null

  @Volatile
  private var joinedNetwork: Network? = null

  @Volatile
  private var joinedSsid: String? = null

  /**
   * True once `onAvailable` has fired for the CURRENT request — i.e. there really was a link to
   * lose. It gates the `released` event in [release]; see the note there.
   */
  @Volatile
  private var everJoined: Boolean = false

  val network: Network?
    get() = joinedNetwork

  val ssid: String?
    get() = joinedSsid

  fun isJoined(): Boolean = joinedNetwork != null

  /**
   * Blocking join. Runs on the session's single ops thread — NEVER on expo's shared
   * `modulesQueue`, which is one HandlerThread for every module in the app; blocking it for
   * 45 s would stall every other module's async functions.
   *
   * [cancelled] is polled so `leaveReaderAp()` can break a join that is still waiting for the
   * user to approve the system dialog (or, in watcher mode, for an AP that has not appeared).
   */
  fun join(options: ValidatedJoin, cancelled: () -> Boolean): Network {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      throw UnsupportedApiLevelException(
        "joining a peer AP needs WifiNetworkSpecifier (Android 10 / API 29); this device is API " +
          Build.VERSION.SDK_INT
      )
    }

    synchronized(lock) {
      if (callback != null) {
        throw JoinFailedException("a peer request is already outstanding — call leaveReaderAp first")
      }
    }

    val specifierBuilder = WifiNetworkSpecifier.Builder().setSsid(options.ssid)
    val passphrase = options.passphrase
    if (passphrase != null) {
      // WPA2-PSK: what `WiFi.softAP(ssid, password)` raises on the ESP32. WPA3/SAE is not
      // offered by the firmware, so setWpa3Passphrase would never match.
      specifierBuilder.setWpa2Passphrase(passphrase)
    }

    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .setNetworkSpecifier(specifierBuilder.build())
      .build()

    val done = CountDownLatch(1)
    val granted = AtomicReference<Network?>(null)
    val failure = AtomicReference<String?>(null)

    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        joinedNetwork = network
        joinedSsid = options.ssid
        everJoined = true
        granted.compareAndSet(null, network)
        emitLinkState(linkBody("joined", options.ssid, peerIpv4(network)?.hostAddress, null))
        done.countDown()
      }

      override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
        // DHCP on the reader's soft AP usually lands after onAvailable, so this is where the
        // peer IPv4 normally becomes readable. Emitted so the UI can show it, and polled by
        // [awaitPeerIpv4] before the listener is bound.
        val ip = firstIpv4(linkProperties)?.hostAddress ?: return
        emitLinkState(linkBody("joined", options.ssid, ip, null))
      }

      override fun onUnavailable() {
        // Platform already released the request (see the class KDoc).
        synchronized(lock) { callback = null }
        joinedNetwork = null
        joinedSsid = null
        val message = "the reader's AP was not found or the join was refused (SSID \"${options.ssid}\")"
        failure.compareAndSet(null, message)
        emitLinkState(linkBody("unavailable", options.ssid, null, message))
        done.countDown()
      }

      override fun onLost(network: Network) {
        val wasJoined = joinedNetwork != null
        joinedNetwork = null
        emitLinkState(linkBody("lost", options.ssid, null, "the reader's AP went away"))
        failure.compareAndSet(null, "the peer link dropped before it could be used")
        done.countDown()
        if (wasJoined) {
          // The reader ended its session, walked out of range, or the AP window closed. The
          // proxy is pointless without the link, so the session tears down rather than sitting
          // on a listening socket nobody can reach.
          onLinkLost("the reader's AP went away")
        }
      }
    }

    // Cleared here, not in [release]: `requestNetwork` has not been called yet, so no callback can
    // race this write. (`onUnavailable` nulls `callback` without going through [release], so this
    // is the one place a stale `true` from a previous request could otherwise survive.)
    synchronized(lock) {
      callback = cb
      everJoined = false
    }
    emitLinkState(linkBody("joining", options.ssid, null, null))

    try {
      if (options.timeoutMs > 0) {
        // The platform timeout fires onUnavailable and releases the request for us. NOTE: the
        // system approval dialog counts INSIDE this window, which is why the default is 45 s
        // and not a few seconds.
        cm.requestNetwork(request, cb, options.timeoutMs)
      } else {
        cm.requestNetwork(request, cb)
      }
    } catch (e: SecurityException) {
      release()
      throw JoinFailedException(
        "requestNetwork was refused: ${e.message ?: "missing CHANGE_NETWORK_STATE / NEARBY_WIFI_DEVICES"}"
      )
    } catch (e: IllegalArgumentException) {
      release()
      throw JoinFailedException("requestNetwork rejected the specifier: ${e.message}")
    }

    // Our own ceiling on top of the platform's: a couple of seconds of grace so the platform's
    // own onUnavailable normally wins and produces the better message.
    val deadline = if (options.timeoutMs > 0) {
      SystemClock.elapsedRealtime() + options.timeoutMs + 2_000L
    } else {
      Long.MAX_VALUE
    }

    while (!done.await(250, TimeUnit.MILLISECONDS)) {
      if (cancelled()) {
        release()
        throw JoinFailedException("join cancelled")
      }
      if (SystemClock.elapsedRealtime() >= deadline) {
        release()
        throw JoinFailedException("timed out waiting for the reader's AP (${options.timeoutMs} ms)")
      }
    }

    val net = granted.get()
    if (net == null) {
      release()
      throw JoinFailedException(failure.get() ?: "the peer link could not be established")
    }
    return net
  }

  /** The phone's own address on the peer link — the address the proxy listener binds to. */
  fun peerIpv4(network: Network): Inet4Address? = firstIpv4(cm.getLinkProperties(network))

  /**
   * Bounded wait for DHCP. A3's note on addressing: the firmware never calls `softAPConfig`, so
   * the ESP-IDF defaults apply (AP 192.168.4.1/24, pool from 192.168.4.2) and the phone is
   * normally .2 — but this reads the address the platform actually assigned instead of
   * hardcoding it, which is also what makes the value safe to show in the UI.
   */
  fun awaitPeerIpv4(network: Network, deadlineMs: Long): Inet4Address? {
    val end = SystemClock.elapsedRealtime() + deadlineMs
    while (true) {
      peerIpv4(network)?.let { return it }
      if (SystemClock.elapsedRealtime() >= end) return null
      try {
        Thread.sleep(ProxyContract.WAIT_POLL_MS)
      } catch (e: InterruptedException) {
        Thread.currentThread().interrupt()
        return null
      }
    }
  }

  private fun firstIpv4(linkProperties: LinkProperties?): Inet4Address? {
    val lp = linkProperties ?: return null
    for (linkAddress in lp.linkAddresses) {
      val address = linkAddress.address
      if (address is Inet4Address && !address.isLoopbackAddress && !address.isAnyLocalAddress) {
        return address
      }
    }
    return null
  }

  /**
   * Idempotent. Unregistering the callback IS what tears the Wi-Fi association down.
   *
   * `released` IS EMITTED ONLY IF THERE WAS A LINK ([everJoined]). Every pre-grant failure in
   * [join] funnels through here — the SecurityException from a missing NEARBY_WIFI_DEVICES, a
   * specifier the platform rejects, our belt-and-braces timeout, an explicit cancel — and the JS
   * reducer treats a `released` arriving before the proxy is up as a hard error ("the reader's WiFi
   * went away before the link was ready"). Emitting it unconditionally therefore ENDED the session
   * with that one wrong sentence for all four, and the real, already-computed reason rides the
   * promise rejection that arrives second and is discarded by first-end-wins. "Put it back into
   * Sync mode" is advice a user whose permission was denied can never act on.
   *
   * A release AFTER a grant keeps emitting it: mid-session that is the ordinary end, and the reducer
   * wants it.
   */
  fun release() {
    val cb = synchronized(lock) {
      val current = callback ?: return
      callback = null
      current
    }
    joinedNetwork = null
    val ssidAtRelease = joinedSsid
    joinedSsid = null
    val hadLink = everJoined
    everJoined = false
    try {
      cm.unregisterNetworkCallback(cb)
    } catch (e: IllegalArgumentException) {
      // Already released by the platform (onUnavailable path). Nothing to do.
    }
    if (hadLink) {
      emitLinkState(linkBody("released", ssidAtRelease, null, null))
    }
  }

  /**
   * The link-event payload, built in ONE place.
   *
   * `state` is drawn from exactly {joining, joined, lost, unavailable, released} because
   * src/services/reader_link.ts DROPS an event whose state it does not recognise
   * (`coerceReaderLinkEvent`) — and a dropped state would leave `sync_session` wedged in
   * `joining` with no timeout having elapsed. Adding a sixth state here is a two-file change.
   *
   * The address is emitted under BOTH `ipv4` (what the JS layer reads) and `peerIp` (this
   * module's own name for it). The two halves have no shared compile step; one extra string per
   * event is cheaper than a field that silently arrives as undefined.
   */
  private fun linkBody(
    state: String,
    ssid: String?,
    ipv4: String?,
    error: String?
  ): Map<String, Any?> = mapOf(
    "state" to state,
    "ssid" to ssid,
    "ipv4" to ipv4,
    "peerIp" to ipv4,
    "error" to error
  )
}
