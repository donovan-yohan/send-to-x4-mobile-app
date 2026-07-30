package expo.modules.readerlink

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * ReaderLinkSession — the one place that knows the whole sequence, so no caller can do it out of
 * order.
 *
 *   joinReaderAp  ->  peer Network granted, phone keeps its default route
 *   startProxy    ->  resolve peer IPv4 -> acquire upstream -> bind listener -> arm the cap
 *   (reader probes /cp-proxy, then polls /m/{boxId}/...)
 *   stopProxy / leaveReaderAp / cap expiry / link loss  ->  everything released
 *
 * THREADING. Every public entry point takes a [Promise] and hands the work to one dedicated
 * single-thread executor. Nothing blocks expo's `modulesQueue`, which is a SINGLE HandlerThread
 * shared by every module in the app (AppContext.kt:66,
 * `HandlerThread("expo.modules.AsyncFunctionQueue")`, dispatched from
 * functions/AsyncFunctionComponent.kt:64) — a 45 s join parked on it would freeze unrelated
 * native calls app-wide. The single ops thread also serialises join/start/stop against each
 * other for free, so there is no window where a stop races a half-finished start.
 *
 * The only work that does NOT go through ops is [statusSnapshot] (volatile reads) and [shutdown]
 * (must finish before the executors die).
 */
internal class ReaderLinkSession(
  context: Context,
  private val emit: (String, Map<String, Any?>) -> Unit
) {
  private val app = context.applicationContext

  private val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

  /**
   * Where an outbox body is allowed to live. Every `bodyPath` in the manifest is canonicalised and
   * refused unless it lands under one of these, because the file is then served onto an OPEN Wi-Fi
   * link. `dataDir` covers expo-file-system's document and cache directories (the app's internal
   * storage); the external ones are listed because a large epub is a plausible thing to stage there.
   *
   * `Context.getDataDir()` is API 24 and this module's minSdk is 24 (expo-module-gradle-plugin
   * default, ProjectConfiguration.kt: `minSdk = ... ?: 24`), so no version gate is needed.
   */
  private val outboxRoots: List<File> = ArrayList<File>(4).apply {
    add(app.dataDir)
    app.getExternalFilesDir(null)?.let { add(it) }
    app.externalCacheDir?.let { add(it) }
  }

  private val ops: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "reader-link-ops").apply { isDaemon = true }
  }
  private val watchdog: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "reader-link-watchdog").apply { isDaemon = true }
    }

  private val cancelJoin = AtomicBoolean(false)
  private val shuttingDown = AtomicBoolean(false)

  // --- state, declared before `peer` because its callbacks close over these ----------------

  @Volatile
  private var linkState: String = "idle"

  @Volatile
  private var peerIp: String? = null

  @Volatile
  private var proxyState: String = "stopped"

  @Volatile
  private var listenAddress: String? = null

  @Volatile
  private var listenPort: Int = 0

  @Volatile
  private var sessionEndsAt: Long = 0L

  @Volatile
  private var lastError: String? = null

  private val requestCount = AtomicInteger(0)
  private val forwardedBytes = AtomicLong(0L)

  @Volatile
  private var lastStatusCode: Int = 0

  // --- local serve ------------------------------------------------------------------------

  @Volatile
  private var outbox: LocalOutbox? = null

  /**
   * True when the session started (or continued) without an internet-capable upstream. It is a
   * REPORTING flag, not a gate: [UpstreamNetwork.current] re-checks per request, so data coming
   * back mid-session flips the mode to `merged` on its own.
   */
  @Volatile
  private var startedOffline: Boolean = false

  /**
   * Whether this phone can currently reach the mailbox. null = nothing has tried yet.
   *
   * THE FIELD THE WHOLE INCIDENT TURNED ON. `upstreamOk` used to be COMPUTED at emit time as
   * `mode != local`, which makes it true by definition in `merged` mode — so a session holding a
   * network whose every forward died reported a healthy upstream, and the app had no field
   * anywhere that could contradict it. It is now an observation: set false when an upstream cannot
   * be acquired or a forward fails, true only when the mailbox actually answered.
   */
  @Volatile
  private var upstreamOk: Boolean? = null

  /** Why [upstreamOk] is false, as a sentence for the status line. */
  @Volatile
  private var upstreamError: String? = null

  /** Kept for the mid-session retry and the DNS probe, both of which outlive `startProxy`. */
  @Volatile
  private var upstreamOrigin: String? = null

  @Volatile
  private var requireCellularUpstream: Boolean = false

  /** The upstream the DNS probe has already run against, so it runs once per network, not per tick. */
  @Volatile
  private var probedUpstream: Network? = null

  private val localBytesServed = AtomicLong(0L)

  /**
   * The last mode signature reported to JS, so [ReaderLinkEvents.PROXY_MODE] is emitted on CHANGES
   * only.
   *
   * A SIGNATURE, not the mode string: mode + upstream reachability + the reason. The mode alone
   * was the wrong key, because the case that needs saying most does not change the mode at all —
   * `merged` with a dead mailbox and `merged` with a live one are the same word, and gating on it
   * meant the app could never be told the difference.
   */
  @Volatile
  private var lastReportedMode: String? = null

  /** Ids whose LAST byte the reader has taken this session. The delivery confirmation, deduped. */
  private val localDelivered: MutableSet<String> =
    Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())

  private val proxyLock = Any()
  private var proxy: MailboxProxyServer? = null
  private var watchdogTask: ScheduledFuture<*>? = null
  private var upstreamTask: ScheduledFuture<*>? = null

  private val peer = PeerApLink(
    cm = cm,
    emitLinkState = { body ->
      linkState = (body["state"] as? String) ?: linkState
      peerIp = (body["peerIp"] as? String) ?: peerIp
      emit(ReaderLinkEvents.LINK_STATE, body)
    },
    onLinkLost = { reason ->
      // Dispatched OFF the ConnectivityManager callback thread: tearing the proxy down joins the
      // acceptor thread, and blocking a platform callback to do that is how you get an ANR that
      // is impossible to read in a stack trace.
      submitQuietly { endSession("linkLost", reason) }
    }
  )

  private val upstream = UpstreamNetwork(cm)

  // ---------------------------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------------------------

  fun join(options: JoinOptions, promise: Promise) {
    val validated = try {
      options.validated()
    } catch (e: CodedException) {
      promise.reject(e)
      return
    }
    cancelJoin.set(false)
    submit(promise) {
      val network = peer.join(validated) { cancelJoin.get() }
      lastError = null
      val ip = peer.awaitPeerIpv4(network, ProxyContract.PEER_ADDRESS_DEADLINE_MS)
      peerIp = ip?.hostAddress
      mapOf(
        "ssid" to validated.ssid,
        "peerIp" to peerIp
      )
    }
  }

  fun leave(promise: Promise) {
    // Set FIRST: this is what breaks a join still parked on the ops thread waiting for the
    // system approval dialog (or, in watcher mode, for an AP that may never appear).
    cancelJoin.set(true)
    submit(promise) {
      endSession("stopped", null)
      mapOf("ok" to true)
    }
  }

  fun startProxy(options: ProxyOptions, promise: Promise) {
    val validated = try {
      options.validated()
    } catch (e: CodedException) {
      promise.reject(e)
      return
    }
    submit(promise) {
      val network = peer.network
        ?: throw NotJoinedException("not joined to the reader's AP — call joinReaderAp first")

      synchronized(proxyLock) {
        if (proxy != null) throw ProxyStartException("the proxy is already running")
      }

      // 1. The listener's local address. No wildcard fallback — see MailboxProxyServer's KDoc.
      val bindAddress = peer.awaitPeerIpv4(network, ProxyContract.PEER_ADDRESS_DEADLINE_MS)
        ?: throw ProxyStartException(
          "the peer link has no IPv4 address yet (DHCP from the reader's AP did not complete " +
            "within ${ProxyContract.PEER_ADDRESS_DEADLINE_MS} ms)"
        )
      peerIp = bindAddress.hostAddress

      // 2. The outbox, read BEFORE the upstream is decided, because whether it holds anything is
      //    what decides whether an upstream is required at all.
      val localOutbox = validated.outboxManifestPath?.let { path ->
        LocalOutbox(path, outboxRoots).also { it.invalidate() }
      }
      val localSnapshot = localOutbox?.snapshot()
      val localTotal = localSnapshot?.items?.size ?: 0
      // PENDING, not items: an item JS has already marked delivered is not something this session
      // can hand over (`latestNote` and `bookLines` both skip delivered entries), so it must not
      // buy an offline start, must not decide the mode, and must not be counted in the number the
      // UI turns into "N items ready to hand over".
      val localPending = localSnapshot?.pending ?: 0
      outbox = localOutbox
      localDelivered.clear()
      localBytesServed.set(0L)
      lastReportedMode = null

      // 3. The upstream, BEFORE listening — and REQUIRED only when there is nothing local to hand
      //    over. The original reasoning still holds for that case: the reader gates discovery on
      //    /cp-proxy, so answering 200 there and then 5xx on every read tells the user "the mailbox
      //    is down" in the one situation they could have fixed (turn data on).
      //
      //    With items queued, the opposite is true. THIS IS THE ZERO INTERNET CASE the whole local
      //    serve exists for: a plane, a subway, a phone with no SIM. Refusing to listen because the
      //    forward would fail would refuse the one delivery that does not need it.
      //
      //    AND IT IS NO LONGER A ONE-SHOT. The acquire below leaves its NetworkRequest outstanding
      //    whether or not it succeeded (see [UpstreamNetwork]), and [armUpstreamRetry] re-checks
      //    while the session runs. A phone that has just given up its Wi-Fi association to join
      //    the reader's AP settles SECONDS after this line runs, which is exactly the window this
      //    used to lose: one 10 s miss and the session forwarded nothing for its whole life.
      startedOffline = false
      upstreamOk = null
      upstreamError = null
      probedUpstream = null
      upstreamOrigin = validated.upstreamOrigin
      requireCellularUpstream = validated.requireCellularUpstream
      try {
        upstream.acquire(validated.requireCellularUpstream, ProxyContract.UPSTREAM_DEADLINE_MS)
      } catch (e: UpstreamUnavailableException) {
        if (localPending == 0) {
          // Nothing local to fall back on, so this session cannot do anything at all. Release the
          // outstanding requests on the way out: the acquire keeps them registered on purpose, and
          // a rejected startProxy leaves nobody to release them later.
          upstream.release()
          throw e
        }
        startedOffline = true
        upstreamOk = false
        upstreamError = e.message
      }

      // 4. Listen.
      val server = MailboxProxyServer(
        bindAddress = bindAddress,
        port = validated.port,
        upstreamOrigin = validated.upstreamOrigin,
        forwardPrefix = validated.forwardPrefix,
        upstreamSupplier = { upstream.current(peer.network) },
        peerNetworkSupplier = { peer.network },
        outbox = localOutbox,
        onActivity = { body -> onProxyActivity(body) },
        onLocalDelivery = { body -> onLocalDelivery(body) }
      )
      try {
        server.start()
      } catch (e: Exception) {
        upstream.release()
        outbox = null
        throw e
      }
      synchronized(proxyLock) { proxy = server }

      // 5. Arm the session cap. A3's foreground mode is "a mode the user enters ... Back to
      //    exit", but a phone in a pocket holding a Wi-Fi association and a listening socket is
      //    not something to leave running, so the cap is unconditional.
      sessionEndsAt = SystemClock.elapsedRealtime() + validated.sessionMaxMs
      armWatchdog(validated.sessionMaxMs.toLong())
      // The upstream is re-checked for the life of the session, not decided once at t=0.
      armUpstreamRetry()

      proxyState = "listening"
      listenAddress = server.listenAddress
      listenPort = validated.port
      lastError = null
      requestCount.set(0)
      forwardedBytes.set(0L)
      lastStatusCode = 0

      val startMode = server.mode()
      val body = mapOf<String, Any?>(
        "state" to "listening",
        // `ipv4` is what src/services/reader_link.ts reads out of both the event and the
        // startProxy result; `address` is this module's own name. Same value, two keys — see the
        // note on PeerApLink.linkBody.
        "ipv4" to server.listenAddress,
        "address" to server.listenAddress,
        "port" to validated.port,
        "healthPath" to ProxyContract.HEALTH_PATH,
        "allowedPathPrefix" to validated.forwardPrefix,
        "readerBaseOrigin" to ("http://" + server.listenAddress + ":" + validated.port),
        "upstreamTransport" to upstream.transportLabel,
        "upstreamMetered" to upstream.isMetered,
        "sessionMaxMs" to validated.sessionMaxMs,
        // What this session can actually deliver, said once at start so the UI can promise it:
        // "N items ready to hand over — no internet needed". `localItems` is the PENDING count on
        // purpose: it is the number the UI renders and the number the mode and the offline start
        // gate are decided on, and a queue holding nothing but already-handed-over items must not
        // claim bytes are coming off the phone. `localTotal` keeps the raw manifest size for
        // anyone who wants it.
        "mode" to startMode,
        "localItems" to localPending,
        "localPending" to localPending,
        "localTotal" to localTotal,
        "localNotes" to (localSnapshot?.notes?.size ?: 0),
        "localBooks" to (localSnapshot?.books?.size ?: 0),
        "localSkipped" to (localSnapshot?.skipped ?: 0),
        "localError" to localSnapshot?.error,
        "offline" to startedOffline,
        "error" to null
      )
      emit(ReaderLinkEvents.PROXY_STATE, body)
      // The mode rides its own channel too: the JS proxy-event coercion is asserted key for key by
      // scripts/sync-session.test.js and deliberately carries no mode, so this is how the very
      // first "no internet needed" claim reaches the status line.
      reportMode(startMode, localPending)
      body
    }
  }

  /**
   * Stops the forwarder; the peer link stays joined.
   *
   * [cancelJoin] is set FIRST even though this call is not about the join, and that is deliberate
   * belt-and-braces against the deadlock class described on [leave]: every entry point is
   * serialised onto the single `ops` thread, so a `stopProxy` submitted while a join is parked in
   * its wait loop can only run once something flips the cancel flag. A caller that tears down with
   * `stopProxy` before `leave` (the natural order, and what the JS teardown used to await
   * sequentially) would otherwise park for the whole join budget — for ever in watcher mode, where
   * there is no platform timeout at all. Flipping it here makes the ordering irrelevant.
   *
   * Safe against a legitimate join: [join] clears the flag on expo's queue before its own work is
   * queued, so a later join is never cancelled by an earlier stop.
   */
  fun stopProxy(promise: Promise) {
    cancelJoin.set(true)
    submit(promise) {
      // A caller-initiated stop is a CLEAN end: whatever `lastError` remembers belongs to some
      // earlier attempt, and attaching it to this event would make a healthy session's end report
      // a stale failure.
      stopProxyInternal(clearLastError = true)
      mapOf("ok" to true)
    }
  }

  fun statusSnapshot(): Map<String, Any?> {
    val remaining = if (sessionEndsAt > 0L) {
      (sessionEndsAt - SystemClock.elapsedRealtime()).coerceAtLeast(0L)
    } else {
      0L
    }
    // Cheap: a stat on a few hundred bytes of JSON (LocalOutbox caches the parse), so this stays
    // safe to poll from a status line and safe to run on expo's modulesQueue.
    val local = outbox?.snapshot()
    val localItems = local?.items?.size ?: 0
    // PENDING decides the mode, exactly as it decides the offline start gate. A queue holding only
    // already-handed-over items has nothing to serve, so calling that `local` or `merged` would
    // claim bytes are coming off the phone when none are.
    val localPending = local?.pending ?: 0
    val upstreamUp = upstream.current(peer.network) != null
    // The same four-way classification MailboxProxyServer uses, `none` included: nothing queued
    // and no route is not "upstream", it is the state where this session can deliver nothing.
    val mode = when {
      localPending > 0 && upstreamUp -> ProxyContract.MODE_MERGED
      localPending > 0 -> ProxyContract.MODE_LOCAL
      upstreamUp -> ProxyContract.MODE_UPSTREAM
      else -> ProxyContract.MODE_NONE
    }
    return mapOf(
      // The one word the UI needs: `local` means this session can deliver with no internet at all.
      "mode" to mode,
      "local" to mapOf(
        "enabled" to (outbox != null),
        "manifestPath" to outbox?.manifestPath,
        "items" to localItems,
        "pending" to localPending,
        "notes" to (local?.notes?.size ?: 0),
        "books" to (local?.books?.size ?: 0),
        // Entries the manifest named that native refused to serve (missing body, size mismatch,
        // unusable filename). Surfaced rather than hidden: it is the only way a queued item that
        // will never leave shows up anywhere.
        "skipped" to (local?.skipped ?: 0),
        "error" to local?.error,
        "delivered" to localDelivered.size,
        "deliveredIds" to localDelivered.toList(),
        "bytesServed" to localBytesServed.get(),
        "startedOffline" to startedOffline
      ),
      "link" to mapOf(
        "state" to linkState,
        "ssid" to peer.ssid,
        "peerIp" to peerIp,
        "joined" to peer.isJoined()
      ),
      "proxy" to mapOf(
        "state" to proxyState,
        "address" to listenAddress,
        "port" to listenPort,
        "healthPath" to ProxyContract.HEALTH_PATH,
        "sessionRemainingMs" to remaining
      ),
      "upstream" to mapOf(
        "transport" to upstream.transportLabel,
        "metered" to upstream.isMetered,
        // OBSERVED, not inferred. `ok` is null until something has actually tried the mailbox.
        "ok" to upstreamOk,
        "error" to upstreamError
      ),
      "counters" to mapOf(
        "requests" to requestCount.get(),
        "bytes" to forwardedBytes.get(),
        "lastStatus" to lastStatusCode
      ),
      "lastError" to lastError
    )
  }

  /**
   * Called from the module's `OnDestroy`. Runs on the caller's thread ON PURPOSE: the executors
   * are shut down immediately afterwards, so deferring the teardown would drop it — and a
   * dropped teardown is a held Wi-Fi association and a listening socket surviving a Metro
   * reload, which the user can only clear by force-stopping the app.
   */
  fun shutdown() {
    if (!shuttingDown.compareAndSet(false, true)) return
    cancelJoin.set(true)
    try {
      endSession("stopped", "the app released the module")
    } catch (e: Exception) {
      // Teardown is best-effort by definition; there is nobody left to report to.
    }
    ops.shutdownNow()
    watchdog.shutdownNow()
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  private fun onProxyActivity(body: Map<String, Any?>) {
    requestCount.incrementAndGet()
    (body["bytes"] as? Long)?.let { forwardedBytes.addAndGet(it) }
    (body["status"] as? Int)?.let { if (it > 0) lastStatusCode = it }
    emit(ReaderLinkEvents.PROXY_ACTIVITY, body)
    // WHAT THE REQUEST LEARNED ABOUT THE MAILBOX, taken before the mode is reported so the two go
    // out together. null means the request never tried the upstream (a local note answered
    // `latest.txt`), which must leave the last real observation alone rather than clearing it.
    (body["upstreamOk"] as? Boolean)?.let { ok ->
      upstreamOk = ok
      upstreamError = if (ok) null else ((body["upstreamError"] as? String) ?: upstreamError)
    }
    // The proxy recomputes the mode per request, so an upstream that dies (or comes back) mid
    // session is visible here and nowhere else. Emitted only on a CHANGE.
    (body["mode"] as? String)?.let { reportMode(it, null) }
  }

  /**
   * Emits [ReaderLinkEvents.PROXY_MODE] when what it would say has actually changed.
   *
   * THE EVENT CARRIES THREE FACTS AND ALL THREE ARE PART OF THE KEY: where the bytes come from,
   * whether the mailbox is reachable from this phone, and why not. It used to carry the first,
   * DERIVE the second from it (`mode != local`, i.e. true whenever anything was queued) and
   * hardcode the third to null — so the app could not tell a working merged session from one whose
   * every forward was failing, which is precisely the session that went unnoticed for an evening.
   *
   * [pendingOverride] is the count the caller already computed at start; null re-reads the cached
   * snapshot, which is a stat on a few hundred bytes of JSON (LocalOutbox caches the parse) and
   * only happens on a transition.
   */
  private fun reportMode(mode: String, pendingOverride: Int?) {
    // An unattempted upstream falls back to the shape of the mode, which is all that is known:
    // `local` and `none` are BY CONSTRUCTION "no route to the mailbox" (the origin is always
    // configured before the radio is touched), so they are honest defaults rather than guesses.
    val ok = upstreamOk ?: (mode != ProxyContract.MODE_LOCAL && mode != ProxyContract.MODE_NONE)
    val detail = if (ok) null else upstreamError
    val signature = mode + "|" + ok + "|" + (detail ?: "")
    if (signature == lastReportedMode) return
    lastReportedMode = signature
    val pending = pendingOverride ?: (outbox?.snapshot()?.pending ?: 0)
    emit(
      ReaderLinkEvents.PROXY_MODE,
      mapOf(
        "mode" to mode,
        "localItems" to pending,
        "upstreamOk" to ok,
        "error" to detail
      )
    )
  }

  /**
   * Re-checks the upstream while the session runs, and reports what it finds.
   *
   * WHY A TIMER AT ALL, when [UpstreamNetwork] keeps its requests outstanding and the platform
   * calls back on its own: because a grant that arrives with the reader between polls changes
   * nothing anybody can see. The proxy only recomputes the mode when a request comes in, so a
   * session that started offline and got data back would go on telling the user "no internet" until
   * the reader happened to ask for something. This is also the only place a NEW upstream gets its
   * DNS checked, which is the one failure that produces no timeout, no status and no log line.
   *
   * Runs on the watchdog thread. The DNS lookup blocks it, bounded by the platform resolver, and
   * once per upstream network rather than once per tick — the session cap is the only other thing
   * on that thread and firing it a couple of seconds late is not a failure.
   */
  private fun retryUpstream() {
    val server = synchronized(proxyLock) { proxy } ?: return
    val peerNetwork = peer.network
    val network = upstream.refresh(requireCellularUpstream, peerNetwork)

    if (network == null) {
      probedUpstream = null
      upstreamOk = false
      upstreamError = upstream.lastError ?: upstreamError
    } else if (network != probedUpstream) {
      probedUpstream = network
      val host = hostOfOrigin(upstreamOrigin)
      val dnsProblem = if (host == null) null else upstream.describeDnsFailure(network, host)
      if (dnsProblem != null) {
        upstreamOk = false
        upstreamError = dnsProblem
      } else {
        // A resolvable host on a held network is the best this side can claim without spending a
        // request the reader is not waiting for. A forward will confirm or contradict it.
        upstreamOk = true
        upstreamError = null
      }
    }
    reportMode(server.mode(), null)
  }

  /**
   * `https://host[:port]` to `host`, or null.
   *
   * Hand-rolled rather than `URL(...).host` because this runs on the watchdog thread and a
   * MalformedURLException there is not worth an exception path: the origin was already validated
   * to `scheme://host[:port]` with no path by `ProxyOptions.validated`, so the string form is
   * known and a miss simply skips the DNS check.
   */
  private fun hostOfOrigin(origin: String?): String? {
    if (origin == null) return null
    val afterScheme = origin.substringAfter("://", "")
    if (afterScheme.isEmpty()) return null
    val host = afterScheme.substringBefore('/').substringBefore(':')
    return host.takeIf { it.isNotEmpty() }
  }

  private fun armUpstreamRetry() {
    val task = Runnable {
      try {
        retryUpstream()
      } catch (e: Exception) {
        // A repeating task that throws is CANCELLED by the executor, silently. This one must
        // survive anything the network stack can produce, because it is also the only thing that
        // ever un-sticks a session that started with no route.
        lastError = e.message ?: e.javaClass.simpleName
      }
    }
    synchronized(proxyLock) {
      upstreamTask?.cancel(false)
      upstreamTask = try {
        watchdog.scheduleWithFixedDelay(
          task,
          ProxyContract.UPSTREAM_PROBE_DELAY_MS,
          ProxyContract.UPSTREAM_RETRY_MS,
          TimeUnit.MILLISECONDS
        )
      } catch (e: RejectedExecutionException) {
        null
      }
    }
  }

  /**
   * A body served from the outbox. `complete` is the delivery confirmation — the reader now holds
   * the item's last byte — and it is what JS turns into "Delivered directly" plus a prune.
   *
   * The id set is kept here as well as emitted because the event can be missed: expo posts events
   * to the JS thread, and a reload between the last byte and the callback would lose it. A JS layer
   * that reconciles against `getStatus().local.deliveredIds` after the session cannot miss one.
   */
  private fun onLocalDelivery(body: Map<String, Any?>) {
    (body["servedBytes"] as? Long)?.let { localBytesServed.addAndGet(it) }
    if (body["complete"] == true) {
      (body["id"] as? String)?.let { localDelivered.add(it) }
    }
    emit(ReaderLinkEvents.LOCAL_DELIVERY, body)
  }

  private fun armWatchdog(delayMs: Long) {
    val minutes = delayMs / 60_000L
    val task = Runnable {
      submitQuietly { endSession("timeout", "the $minutes minute session cap expired") }
    }
    synchronized(proxyLock) {
      watchdogTask?.cancel(false)
      watchdogTask = try {
        watchdog.schedule(task, delayMs, TimeUnit.MILLISECONDS)
      } catch (e: RejectedExecutionException) {
        null
      }
    }
  }

  /**
   * [clearLastError] is passed, not inferred, because only the CALLER knows whether this stop is a
   * clean one. The `stopped` event carries `lastError` — that is the only channel a native-only
   * reason (this module's session cap, above all) has into the UI, since `onSessionEnd` always
   * arrives after the `stopped` that has already ended the JS session. So the field has to be right:
   * carried for a native-initiated end, cleared for a clean stop.
   */
  private fun stopProxyInternal(clearLastError: Boolean) {
    val server = synchronized(proxyLock) {
      watchdogTask?.cancel(false)
      watchdogTask = null
      upstreamTask?.cancel(false)
      upstreamTask = null
      val current = proxy
      proxy = null
      current
    }
    sessionEndsAt = 0L
    server?.stop()
    upstream.release()
    upstreamOk = null
    upstreamError = null
    upstreamOrigin = null
    probedUpstream = null
    if (clearLastError) lastError = null

    // The delivered set is NOT cleared here. `stopProxy` resolves before the JS layer has read it,
    // and a session that ends on the watchdog or on link loss ends with nobody having asked yet, so
    // the ids have to outlive the proxy for the reconcile-after-the-fact path to work. The next
    // startProxy clears them.
    val hadOutbox = outbox != null
    outbox = null

    if (proxyState != "stopped") {
      proxyState = "stopped"
      listenAddress = null
      listenPort = 0
      emit(
        ReaderLinkEvents.PROXY_STATE,
        mapOf(
          "state" to "stopped",
          "ipv4" to null,
          "port" to null,
          // Carried on the stopped event because it is the last one the JS session sees: whatever
          // the reader took locally is confirmed delivered, and JS prunes on exactly this.
          "localDelivered" to localDelivered.size,
          "localDeliveredIds" to localDelivered.toList(),
          "localBytesServed" to localBytesServed.get(),
          "localEnabled" to hadOutbox,
          "error" to lastError
        )
      )
    }
  }

  /** Idempotent full teardown plus exactly one `onSessionEnd` when there was a session. */
  private fun endSession(reason: String, message: String?) {
    val hadSession = proxyState != "stopped" || peer.isJoined()
    // "stopped" is the caller asking (leaveReaderAp, OnDestroy); anything else is this module
    // deciding, and then the message is the only account of why the session ended that exists.
    val clean = reason == "stopped"
    if (message != null && !clean) lastError = message
    stopProxyInternal(clearLastError = clean)
    peer.release()
    if (hadSession) {
      emit(
        ReaderLinkEvents.SESSION_END,
        mapOf("reason" to reason, "message" to message)
      )
    }
  }

  /**
   * Runs [work] on the ops thread and settles [promise] exactly once. A [CodedException] keeps
   * its code so the TS wrapper can branch on it; anything else is wrapped rather than leaking a
   * raw JVM class name into JS.
   */
  private fun submit(promise: Promise, work: () -> Map<String, Any?>) {
    val task = Runnable {
      try {
        promise.resolve(work())
      } catch (e: CodedException) {
        lastError = e.message
        promise.reject(e)
      } catch (e: Exception) {
        val message = e.message ?: e.javaClass.simpleName
        lastError = message
        promise.reject(CodedException("ERR_READER_LINK", message, e))
      }
    }
    try {
      ops.execute(task)
    } catch (e: RejectedExecutionException) {
      promise.reject(
        CodedException("ERR_READER_LINK", "the reader-link module is shutting down", e)
      )
    }
  }

  private fun submitQuietly(work: () -> Unit) {
    try {
      ops.execute {
        try {
          work()
        } catch (e: Exception) {
          lastError = e.message ?: e.javaClass.simpleName
        }
      }
    } catch (e: RejectedExecutionException) {
      // shutting down
    }
  }
}
