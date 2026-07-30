package expo.modules.readerlink

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * ReaderLinkModule — the JS boundary for Appendix A3's phone-as-mailbox-proxy.
 *
 * ALL native behaviour for the peer link lives in this one module (locked architecture): the
 * WifiNetworkSpecifier join, the HTTP forwarder, and the two-Network socket binding. Nothing
 * about it leaks into the app's MainActivity/MainApplication, and it adds no gradle dependency.
 *
 * WHAT THIS MODULE CANNOT DO, BY CONSTRUCTION
 *   - It cannot write to the mailbox. The forwarder accepts GET and HEAD only, and it never
 *     attaches an `Authorization` header (HttpWire drops inbound ones and
 *     MailboxProxyServer.forward sets an explicit, closed header set). §2's write token lives in
 *     the JS layer (`src/services/mailbox_client.ts`) and has no path into this module: no
 *     function here takes a token, so there is nothing to leak onto the peer interface.
 *   - It cannot serve anything but `/cp-proxy`, `/cp-wifi` and `/m/…`. The first two are answered
 *     LOCALLY and can never become a forward; `/cp-wifi` additionally does not exist at all unless
 *     the caller passed `wifiSharePath`, and it is the only path that accepts a method other than
 *     GET/HEAD (a DELETE, which is the reader's ack). See [ProxyContract.WIFI_PATH].
 *   - It cannot read a file outside this app's own storage. The local-serve outbox names its bodies
 *     by path, and every one of them is canonicalised and refused unless it sits under `dataDir` or
 *     an external files directory belonging to this app (see [ReaderLinkSession] and [LocalOutbox]).
 *
 * API-SURFACE PROVENANCE (checked against the installed expo-modules-core 3.0.29, since the
 * Kotlin here is not compile-verified in this workflow):
 *   - `Module`, `ModuleDefinition`, `sendEvent(name, Map)`:
 *     android/src/main/java/expo/modules/kotlin/modules/Module.kt
 *   - `Name`, `Events`, `OnCreate`, `OnDestroy`:
 *     .../kotlin/modules/ModuleDefinitionBuilder.kt (Name:74, OnCreate:109, OnDestroy:123) and
 *     .../kotlin/objects/ObjectDefinitionBuilder.kt (Events:439)
 *   - `AsyncFunction(name) { p0, promise -> }` (the promise-taking overload used everywhere here):
 *     .../kotlin/objects/ObjectDefinitionBuilder.kt:269-274 (`@JvmName("AsyncFunctionWithPromise")`,
 *     body `(p0: P0, p1: Promise) -> R`), no-arg promise form at :245-246
 *   - `Promise.resolve(Map<String, Any?>)` / `reject(CodedException)`:
 *     .../kotlin/Promise.kt
 *   - `Record` + `@Field`: .../kotlin/records/{Record,Field}.kt; assignment goes through
 *     `javaField.set` (RecordTypeConverter.kt), hence `var` fields in Options.kt
 *   - events are delivered to JS via `JNIUtils.emitEvent` ->
 *     `jsiContext->runtimeHolder->jsInvoker->invokeAsync` (cpp/JNIUtils.cpp:176), i.e. the emit is
 *     POSTED to the JS thread. That is why [emitSafely] can be called straight off a
 *     ConnectivityManager callback or a socket worker without hopping threads first.
 */
class ReaderLinkModule : Module() {
  private var session: ReaderLinkSession? = null

  private fun requireSession(): ReaderLinkSession =
    session ?: throw Exceptions.AppContextLost()

  private fun emitSafely(name: String, body: Map<String, Any?>) {
    try {
      sendEvent(name, body)
    } catch (e: Throwable) {
      // The JS object can be torn down between a socket completing and its event landing (a
      // reload, a backgrounded app). Telemetry is never worth taking down a network thread for.
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ReaderLink")

    Events(
      ReaderLinkEvents.LINK_STATE,
      ReaderLinkEvents.PROXY_STATE,
      ReaderLinkEvents.PROXY_ACTIVITY,
      ReaderLinkEvents.SESSION_END,
      // An event name missing from this list is not a compile error and not a runtime crash: the
      // emit is swallowed by [emitSafely] and the feature simply never reports. So adding an event
      // is always a two-line change, here and in ProxyContract — and this list is compared against
      // the names src/services/reader_link.ts subscribes to by
      // scripts/reader-link-contract.test.js, which is the only thing that can fail on a drift.
      ReaderLinkEvents.PROXY_MODE,
      ReaderLinkEvents.LOCAL_DELIVERY,
      ReaderLinkEvents.WIFI_SHARE
    )

    OnCreate {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      session = ReaderLinkSession(context) { name, body -> emitSafely(name, body) }
    }

    /**
     * Joins the reader's AP as a peer. Resolves `{ ssid, peerIp }` once the platform reports the
     * network available; `peerIp` may still be null if DHCP has not finished, in which case
     * `startProxy` waits for it.
     *
     * The FIRST join shows a system approval dialog. A3: "later re-joins of an approved specifier
     * may skip it depending on platform version — verify on device, do not design around it."
     */
    AsyncFunction("joinReaderAp") { options: JoinOptions, promise: Promise ->
      requireSession().join(options, promise)
    }

    /** Releases the peer request (which is what tears the association down) and any proxy. */
    AsyncFunction("leaveReaderAp") { promise: Promise ->
      requireSession().leave(promise)
    }

    /**
     * Starts the forwarder on the peer interface. Requires a joined link. Resolves the listening
     * address/port plus `readerBaseOrigin`, which is the `http://{peerIp}:{port}` half of the
     * base the reader needs (A3: peer base = that origin + the path portion of the configured
     * mailbox base, i.e. `/m/{boxId}`).
     */
    AsyncFunction("startProxy") { options: ProxyOptions, promise: Promise ->
      requireSession().startProxy(options, promise)
    }

    /** Stops the forwarder and releases the upstream request; the peer link stays joined. */
    AsyncFunction("stopProxy") { promise: Promise ->
      requireSession().stopProxy(promise)
    }

    /** Cheap snapshot for a status line; safe to poll. Never touches the network. */
    AsyncFunction("getStatus") { promise: Promise ->
      promise.resolve(requireSession().statusSnapshot())
    }

    OnDestroy {
      session?.shutdown()
      session = null
    }
  }
}
