package expo.modules.readerlink

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.SystemClock
import java.net.UnknownHostException

/**
 * UpstreamNetwork — resolves the network the forward goes OUT on, and it is the half of this
 * module that is easiest to get wrong.
 *
 * A3, on why: "Two `Network` objects in one process, and this is the hard part of the module.
 * The proxy's *inbound* listener must be bound to the peer `Network`, and its *outbound* fetch
 * to the cellular one. That rules out `bindProcessToNetwork`, which is process-wide and would
 * send one of the two the wrong way ... Getting this wrong fails in the most confusing possible
 * way: the reader's requests arrive, the forward silently goes out over the peer link, and
 * everything times out with no error anywhere."
 *
 * ------------------------------------------------------------------------------------------
 * THE CHOICE: `getActiveNetwork()` vs `requestNetwork(...)`, decided and recorded
 * ------------------------------------------------------------------------------------------
 * NOT THE MECHANISM, BUT A GUARDED LAST RESORT — `ConnectivityManager.getActiveNetwork()`. It
 * returns the PROCESS DEFAULT, which is a global the module does not own: any other component (or a
 * future `bindProcessToNetwork` anywhere in the app) can move it, it can be null while the radios
 * settle, and betting the whole transport on "a network without NET_CAPABILITY_INTERNET can never be
 * the default" is betting on an invariant we cannot enforce from here. When it is wrong, the symptom
 * is precisely the silent timeout A3 warns about — so it is NOT what the session runs on. [current]
 * does fall back to it for the window where the held request has momentarily lapsed, and the two
 * guards there are what make that safe rather than a bet: the candidate is rejected if it is the
 * peer `Network` by identity (the failure mode A3 describes — the forward going out over the peer
 * link) and rejected if it does not currently hold NET_CAPABILITY_INTERNET (which also covers null
 * and a half-settled radio). Nothing else about the process default is trusted, and a candidate that
 * fails either guard becomes a clean 503 rather than a hang.
 *
 * (This paragraph used to read "REJECTED" while the code had the fallback. Recorded here because a
 * rationale that has quietly become false is worse than none: the next reader changes the guards
 * believing there is nothing behind them.)
 *
 * CHOSEN — an explicit, held `requestNetwork` for an INTERNET-capable network, used per-socket
 * via `Network.openConnection(url)`. Four reasons:
 *   1. It cannot resolve to the peer link. The peer request removes NET_CAPABILITY_INTERNET, an
 *      open soft AP with no route never gets it, and a specifier-matched network is only
 *      reported to requests carrying that same specifier. Belt and braces: [current] also
 *      compares the resolved Network against the peer Network by identity and refuses a match.
 *   2. Holding the request keeps the upstream up for the length of the session instead of
 *      hoping the default survives a peer join.
 *   3. It gives a callback for "upstream lost", so the failure becomes an event the UI can show
 *      rather than a stalled download.
 *   4. It stays correct under STA+STA concurrency (Android 12+ on capable hardware), where the
 *      phone may KEEP its home Wi-Fi while joined to the reader's AP. Pinning
 *      TRANSPORT_CELLULAR there would force the cellular radio up and spend metered data for
 *      no reason.
 *
 * ------------------------------------------------------------------------------------------
 * TWO LEGS, AND WHY THE SECOND ONE EXISTS — the incident this class was rewritten for
 * ------------------------------------------------------------------------------------------
 * A whole 'Sync with app' session ran with the reader talking happily to the phone and NOT ONE
 * request reaching the mailbox. Every forward is opened on the network this class hands back, so
 * "zero mailbox log lines" means this class handed back nothing (or handed back something with no
 * route). The old shape made both indistinguishable AND unrecoverable:
 *
 *   - `acquire` registered ONE generic INTERNET request, waited 10 s, and on expiry
 *     UNREGISTERED it and threw. From that moment the session had no outstanding request at all,
 *     so a data connection that came up thirty seconds later — the phone settling after it gave up
 *     its Wi-Fi association to join the reader's AP, which is exactly when this happens — was
 *     never granted to anybody. The session was forward-dead for its whole life on the strength of
 *     one 10 s window.
 *   - Nothing ever asked for CELLULAR. On a phone whose only route out is the cellular radio and
 *     whose radio is idle, a generic request can sit unmatched while a TRANSPORT_CELLULAR request
 *     would have brought the data connection up.
 *
 * So there are now two legs and NEITHER is ever torn down before [release]:
 *   PRIMARY   generic NET_CAPABILITY_INTERNET (or cellular-pinned when the caller asked). Kept
 *             outstanding for the whole session, which is what makes a late grant work: the
 *             platform calls `onAvailable` whenever the route appears and [current] picks it up on
 *             the very next request, with no polling and no scan (A3 forbids scanning).
 *   CELLULAR  TRANSPORT_CELLULAR, armed ONLY after the primary produced nothing inside its
 *             deadline. Deliberately lazy, for reason 4 above: arming it eagerly would fire the
 *             cellular radio up on every session, including the STA+STA ones where a free Wi-Fi
 *             upstream is right there.
 *
 * ------------------------------------------------------------------------------------------
 * "GENUINELY ROUTABLE", INCLUDING DNS
 * ------------------------------------------------------------------------------------------
 * A network holding NET_CAPABILITY_INTERNET only claims the SYSTEM believes it can reach the
 * internet. NET_CAPABILITY_VALIDATED is the one that says the platform's own connectivity check
 * actually came back — the difference between "the radio is up" and "packets get answered", and
 * the difference between a captive portal and a working link. [current] therefore prefers a
 * validated candidate and only falls back to an unvalidated one when that is all there is, which
 * keeps a half-settled radio from silently becoming the upstream for a whole session.
 *
 * DNS is the other half, and it is the half that produces no log line anywhere when it fails.
 * Every forward is opened with `Network.openConnection(url)`, which resolves the host ON THAT
 * NETWORK — so a mailbox origin that only resolves on the phone's own Wi-Fi (a LAN name, a
 * tailnet-only name, a split-horizon record) works for every `fetch()` in the app and can NEVER
 * work from the proxy, with both halves silent about it. [describeDnsFailure] does that lookup
 * deliberately, once per upstream, so the failure becomes a sentence the session can show instead
 * of an eight-second connect timeout nobody sees.
 *
 * [transportLabel]/[isMetered] exist for A3's UI note: "a phone joined to a 2.4 GHz peer AP has
 * given up its own Wi-Fi association — so the *phone* is on cellular for the session. Worth one
 * line in the app UI; a user on metered data should know."
 */
internal class UpstreamNetwork(
  private val cm: ConnectivityManager
) {
  private val lock = Any()

  /**
   * One outstanding `NetworkRequest` and whatever the platform has granted it.
   *
   * The callback is the object itself so registration is one field, and `registered` is guarded by
   * the enclosing lock because `unregisterNetworkCallback` throws IllegalArgumentException on a
   * callback that was never registered (and, worse, silently leaks one that is registered twice).
   */
  private inner class Leg(
    val name: String,
    private val request: NetworkRequest
  ) : ConnectivityManager.NetworkCallback() {

    @Volatile
    var granted: Network? = null
      private set

    @Volatile
    var transport: String = "unknown"
      private set

    @Volatile
    var metered: Boolean = true
      private set

    private var registered = false

    /** Idempotent. Throws only for the one failure a retry cannot fix: a missing permission. */
    fun register() {
      synchronized(lock) {
        if (registered) return
        registered = true
      }
      try {
        cm.requestNetwork(request, this)
      } catch (e: SecurityException) {
        synchronized(lock) { registered = false }
        throw UpstreamUnavailableException(
          "requestNetwork for the upstream was refused: ${e.message ?: "missing CHANGE_NETWORK_STATE"}"
        )
      }
    }

    fun unregister() {
      synchronized(lock) {
        if (!registered) return
        registered = false
      }
      granted = null
      transport = "unknown"
      try {
        cm.unregisterNetworkCallback(this)
      } catch (e: IllegalArgumentException) {
        // Already released by the platform.
      }
    }

    /**
     * Bounded wait for a grant, polled rather than latched.
     *
     * A CountDownLatch would be cheaper and WRONG here: it fires once, so a leg that was granted,
     * lost, and is being waited on again would return instantly with nothing held. Polling
     * [ProxyContract.WAIT_POLL_MS] re-reads the actual state every tick.
     */
    fun awaitGrant(deadlineMs: Long): Boolean {
      val end = SystemClock.elapsedRealtime() + deadlineMs
      while (granted == null) {
        val remaining = end - SystemClock.elapsedRealtime()
        if (remaining <= 0L) break
        try {
          Thread.sleep(if (remaining < ProxyContract.WAIT_POLL_MS) remaining else ProxyContract.WAIT_POLL_MS)
        } catch (e: InterruptedException) {
          Thread.currentThread().interrupt()
          break
        }
      }
      return granted != null
    }

    override fun onAvailable(network: Network) {
      granted = network
      describe(cm.getNetworkCapabilities(network))
    }

    override fun onCapabilitiesChanged(
      network: Network,
      networkCapabilities: NetworkCapabilities
    ) {
      if (network == granted) describe(networkCapabilities)
    }

    override fun onLost(network: Network) {
      if (network == granted) granted = null
    }

    private fun describe(caps: NetworkCapabilities?) {
      if (caps == null) return
      transport = when {
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        else -> "other"
      }
      metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }
  }

  private var primary: Leg? = null
  private var cellular: Leg? = null

  /** The leg [current] last answered from, so the labels describe the network actually in use. */
  @Volatile
  private var chosen: Leg? = null

  /** Why there is no upstream right now, as a sentence. Null while one is held. */
  @Volatile
  var lastError: String? = null
    private set

  val transportLabel: String
    get() = chosen?.transport ?: "unknown"

  val isMetered: Boolean
    get() = chosen?.metered ?: true

  /**
   * Blocking, bounded. Called from the session ops thread, never from expo's modulesQueue.
   *
   * THE REQUESTS SURVIVE A FAILURE. Throwing here means "there is no route RIGHT NOW", not "give
   * up": both legs stay registered, so the platform grants one the moment a route appears and the
   * session flips from `local` to `merged` on the next request with nothing polling for it. The
   * old code unregistered on expiry, which is how a 10 s window at the start of a session decided
   * the whole session.
   */
  fun acquire(requireCellular: Boolean, deadlineMs: Long) {
    val first = ensurePrimary(requireCellular)
    if (first.awaitGrant(deadlineMs)) {
      chosen = first
      lastError = null
      return
    }

    // The primary found nothing. Ask for cellular EXPLICITLY now — see the two-legs note: a
    // generic request can sit unmatched on a phone whose only route is an idle cellular radio.
    if (!requireCellular) {
      val fallback = ensureCellular()
      if (fallback != null && fallback.awaitGrant(ProxyContract.UPSTREAM_FALLBACK_DEADLINE_MS)) {
        chosen = fallback
        lastError = null
        return
      }
    }

    val detail = if (requireCellular) {
      "no cellular data connection is available to forward to the mailbox"
    } else {
      "no internet connection on this phone to reach the mailbox with"
    }
    lastError = detail
    throw UpstreamUnavailableException(detail)
  }

  /**
   * REGISTERS THE REQUEST AND RETURNS. The same thing [acquire] does first, without the wait.
   *
   * WHY IT EXISTS: for a session that already has items queued, the wait in [acquire] cannot change
   * a single thing the session then does. That branch catches [UpstreamUnavailableException] and
   * listens anyway, both legs stay registered either way, and [refresh] re-checks on a timer, so the
   * only effect of blocking was to hold the listening socket down for up to
   * `UPSTREAM_DEADLINE_MS + UPSTREAM_FALLBACK_DEADLINE_MS` while the reader probed a closed port,
   * on exactly the phone with no route, which is the offline handover this whole path exists for.
   *
   * The CELLULAR leg is deliberately not armed here, for the reason the two-legs note gives: it
   * would fire the radio up on every session. [refresh] arms it a second later, and only while the
   * primary is still holding nothing, which keeps the laziness and drops the ten second wait.
   *
   * Throws the one failure a retry cannot fix, a missing permission, exactly as [acquire] does.
   */
  fun arm(requireCellular: Boolean) {
    ensurePrimary(requireCellular)
  }

  /**
   * NON-BLOCKING re-attempt, for the session's mid-session retry.
   *
   * Registers whatever is not registered (including the cellular leg, once the primary has had its
   * chance) and answers with whatever is usable now. This is the "retry rather than latch local at
   * t=0" half: the platform is doing the waiting, this just makes sure something is asking.
   */
  fun refresh(requireCellular: Boolean, peer: Network?): Network? {
    try {
      ensurePrimary(requireCellular)
      if (!requireCellular && primary?.granted == null) ensureCellular()
    } catch (e: UpstreamUnavailableException) {
      lastError = e.message
      return null
    }
    val network = current(peer)
    lastError = if (network == null) {
      lastError ?: "no internet connection on this phone to reach the mailbox with"
    } else {
      null
    }
    return network
  }

  private fun ensurePrimary(requireCellular: Boolean): Leg {
    val leg = synchronized(lock) {
      primary ?: Leg("primary", buildRequest(requireCellular)).also { primary = it }
    }
    leg.register()
    return leg
  }

  private fun ensureCellular(): Leg? {
    val leg = synchronized(lock) {
      cellular ?: Leg("cellular", buildRequest(true)).also { cellular = it }
    }
    return try {
      leg.register()
      leg
    } catch (e: UpstreamUnavailableException) {
      lastError = e.message
      null
    }
  }

  private fun buildRequest(requireCellular: Boolean): NetworkRequest {
    val builder = NetworkRequest.Builder()
      .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    if (requireCellular) {
      builder.addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
    }
    return builder.build()
  }

  /**
   * The network a forward should use, or null. Re-checked per request rather than cached: the
   * upstream can drop mid-session and the answer must then be a clean 503, not a hang.
   *
   * VALIDATED FIRST. An INTERNET-capable but unvalidated network is the shape of a captive portal
   * and of a radio that has associated but not yet routed — both of which connect and then answer
   * nothing, which is the exact failure this whole class was rewritten for. It is still accepted
   * as a last resort (some carriers report NOT_VALIDATED for long stretches on a link that works),
   * but never in preference to one the platform has actually checked.
   */
  fun current(peer: Network?): Network? {
    val validated = pick(peer, requireValidated = true)
    if (validated != null) return validated
    val anyInternet = pick(peer, requireValidated = false)
    if (anyInternet != null) return anyInternet

    // Last-resort fallback on the PROCESS DEFAULT, used only for the window where the held request
    // has momentarily lapsed, and guarded on the two counts that make it safe rather than a bet —
    // see the class KDoc: it is never the peer link (identity), and it is internet-capable right now
    // (which also covers null and a half-settled radio). Failing either is a clean 503 upstack, not
    // a hang. DO NOT relax either guard without rewriting that paragraph too.
    val active = cm.activeNetwork ?: return null
    if (active == peer) return null
    if (!hasInternet(active)) return null
    return active
  }

  private fun pick(peer: Network?, requireValidated: Boolean): Network? {
    val legs = synchronized(lock) { listOfNotNull(primary, cellular) }
    for (leg in legs) {
      val held = leg.granted ?: continue
      if (held == peer) continue
      if (!hasInternet(held)) continue
      if (requireValidated && !isValidated(held)) continue
      chosen = leg
      return held
    }
    return null
  }

  /**
   * Looks the mailbox host up ON [network], returning null when it resolved and a sentence when it
   * did not.
   *
   * THIS IS THE ONE CHECK THAT PRODUCES A NAME FOR THE INVISIBLE FAILURE. Both upstream call sites
   * go through `Network.openConnection`, so their DNS rides this network too — and a name that
   * only exists on the phone's own Wi-Fi resolves everywhere else in the app while failing here
   * forever, with the failure showing up as a connect timeout that nothing logs. Blocking, and
   * bounded by the platform resolver, so callers run it off the request path.
   */
  fun describeDnsFailure(network: Network, host: String): String? {
    if (host.isEmpty()) return null
    val where = transportLabel
    return try {
      val addresses = network.getAllByName(host)
      if (addresses == null || addresses.isEmpty()) {
        "the mailbox address $host has no route on this phone's $where connection"
      } else {
        null
      }
    } catch (e: UnknownHostException) {
      "the mailbox address $host could not be looked up on this phone's $where connection"
    } catch (e: SecurityException) {
      "looking up the mailbox address $host was refused on this phone's $where connection"
    }
  }

  private fun hasInternet(network: Network): Boolean {
    val caps = cm.getNetworkCapabilities(network) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
  }

  private fun isValidated(network: Network): Boolean {
    val caps = cm.getNetworkCapabilities(network) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
  }

  fun release() {
    val legs = synchronized(lock) {
      val current = listOfNotNull(primary, cellular)
      primary = null
      cellular = null
      current
    }
    chosen = null
    lastError = null
    for (leg in legs) leg.unregister()
  }
}
