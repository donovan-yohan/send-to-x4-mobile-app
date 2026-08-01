package expo.modules.readerlink

/**
 * ProxyContract — the numbers and strings that are HALF OF A WIRE CONTRACT with the reader
 * firmware. Anything in here has a counterpart in the firmware repo; changing a value here
 * without changing it there breaks discovery silently (the reader probes, gets nothing it
 * recognises, and falls through to "no proxy" with no error anywhere).
 *
 * Authority: docs/xteink/mailbox-books-contract.md Appendix A3.
 */
object ProxyContract {
  /**
   * The reader's soft-AP SSID. `AP_SSID = "CrossPoint-Reader"` in the firmware
   * (`src/activities/network/CrossPointWebServerActivity.cpp:23-27`). The AP is open today;
   * A3 requires a per-device PSK for the unattended variant, which is why the JS layer
   * carries a stored `readerApPsk` setting and this module accepts an optional passphrase.
   */
  const val READER_AP_SSID = "CrossPoint-Reader"

  /**
   * THE SECURITY FINDING, encoded. A3: the reader must NOT discover the proxy by sending
   * `GET /m/{boxId}/latest.txt` to candidate IPs, because `boxId` *is* the read capability for
   * the whole mailbox and the first station to associate with an open AP could be a stranger.
   * So the reader probes this fixed, boxId-free path first and only sends `/m/{boxId}/...` to a
   * candidate that answered it.
   *
   * THE PROXY MUST ANSWER THIS. It is answered LOCALLY — never forwarded upstream — so it
   * stays cheap and works even before the first real request.
   *
   * Response shape. THIS IS PINNED BY THE SPEC, NOT CHOSEN HERE — A3's health-probe finding says
   * the firmware (`m2-3-sync-activity`, `PeerProbe.cpp`) accepts a body whose first non-whitespace
   * token is `cp-proxy`, optionally `cp-proxy/<version>`, and that "the app proxy MUST answer
   * `200 text/plain` body `cp-proxy/1`". Byte-for-byte:
   *
   *   200 OK
   *   Content-Type: text/plain; charset=utf-8
   *   Content-Length: 11
   *   Connection: close
   *
   *   cp-proxy/1\n
   *
   * The version rides AFTER the slash so a later bump cannot brick discovery (the firmware matches
   * on the `cp-proxy` token, not on the whole string). These three values — path, body, port — are
   * the ones the parallel firmware workflow must match exactly, so A3 carries a canonical block of
   * them and `scripts/reader-link-contract.test.js` fails when this file and that block disagree.
   */
  const val HEALTH_PATH = "/cp-proxy"
  const val HEALTH_BODY = "cp-proxy/1\n"
  const val HEALTH_CONTENT_TYPE = "text/plain; charset=utf-8"

  /** The ONLY forwardable prefix. §2's mailbox paths all live under `/m/{boxId}/`. */
  const val FORWARD_PREFIX = "/m/"

  /** A3 writes the peer base as `http://192.168.4.2:8080/m/{boxId}`. */
  const val DEFAULT_PORT = 8080

  /**
   * A foreground session is bounded. 30 min hard cap, 1 min floor.
   *
   * This DEFAULT is the fallback for a caller that passes nothing; the app always passes its own
   * `sessionMaxMs` (= `PROXY_SESSION_MAX_MS` in src/services/reader_link.ts) so the JS deadline and
   * this watchdog expire together instead of being two independent caps.
   */
  const val DEFAULT_SESSION_MAX_MS = 30 * 60 * 1000
  const val MIN_SESSION_MAX_MS = 60 * 1000
  const val MAX_SESSION_MAX_MS = 30 * 60 * 1000

  /**
   * Join budget. `requestNetwork(request, callback, timeoutMs)` counts the SYSTEM APPROVAL
   * DIALOG inside its timeout, so this is generous; 0 means "no platform timeout", which is
   * what the queued-delivery watcher wants (A3: keep the request outstanding, never scan).
   */
  const val DEFAULT_JOIN_TIMEOUT_MS = 45_000
  const val MIN_JOIN_TIMEOUT_MS = 5_000
  const val MAX_JOIN_TIMEOUT_MS = 300_000

  /** How long `startProxy` waits for DHCP on the peer link before giving up. */
  const val PEER_ADDRESS_DEADLINE_MS = 8_000L

  /** How long `startProxy` waits for an internet-capable upstream before giving up. */
  const val UPSTREAM_DEADLINE_MS = 10_000L

  /**
   * How long the CELLULAR-pinned second leg gets, after the generic request found nothing.
   *
   * Shorter than [UPSTREAM_DEADLINE_MS] because by the time it is armed the user has already been
   * waiting that long with a reader in front of them, and because the case it exists for — an idle
   * cellular radio that only comes up when something explicitly asks for it — resolves fast or not
   * at all. Failing it is not the end of anything: both requests stay outstanding for the whole
   * session, so a later grant still flips the session to `merged`. See [UpstreamNetwork].
   */
  const val UPSTREAM_FALLBACK_DEADLINE_MS = 8_000L

  /**
   * How often a running session re-checks the upstream.
   *
   * NOT a scan and not a poll of the radio: [UpstreamNetwork.refresh] only makes sure a request is
   * outstanding and re-reads what the platform has already granted. It exists because a session
   * that started with no route must not stay forward-dead for its whole life — the phone settles
   * seconds AFTER it gives up its Wi-Fi association to join the reader's AP, which is exactly when
   * the first attempt fails. It is also where the mode event gets re-emitted, so the status line
   * stops lying within one interval of the truth changing.
   */
  const val UPSTREAM_RETRY_MS = 20_000L

  /**
   * Delay before the FIRST post-start upstream check, which is also the one that resolves the
   * mailbox host on the upstream network. Short: it is the answer to "is this session going to be
   * able to reach the mailbox at all", and the user is standing there.
   */
  const val UPSTREAM_PROBE_DELAY_MS = 1_500L

  /** Poll granularity for the two bounded waits above. */
  const val WAIT_POLL_MS = 100L

  /**
   * Concurrency cap. The reader polls one request at a time and `AP_MAX_CONNECTIONS = 4`, so
   * anything past this is either a bug or an attack; extra connections are dropped without a
   * response (cheapest possible answer, and it never blocks the accept loop).
   */
  const val MAX_CONCURRENT_CONNECTIONS = 4
  const val ACCEPT_BACKLOG = 8

  /** Per-connection inbound read timeout. The reader either speaks promptly or is gone. */
  const val CLIENT_SOCKET_TIMEOUT_MS = 15_000

  /** Upstream budgets. `readTimeout` is per-read, so a 24 MiB book is not capped by it. */
  const val UPSTREAM_CONNECT_TIMEOUT_MS = 8_000
  const val UPSTREAM_READ_TIMEOUT_MS = 20_000

  /**
   * Streaming chunk. A book is up to MAX_BOOK_BYTES = 24 MiB (§2) and MUST NOT be buffered —
   * the phone would OOM and the reader would stall waiting for a body that never starts.
   */
  const val STREAM_CHUNK_BYTES = 16 * 1024

  /** Sent upstream so mailbox logs can tell a proxied read from a direct one. */
  const val UPSTREAM_USER_AGENT = "cp-proxy/1 (reader-link)"

  // -----------------------------------------------------------------------------------------
  // LOCAL SERVE — answering the contract from the phone's own outbox, with no internet at all
  //
  // The four endpoint tails below are section 2's, and they are matched on the TAIL of the path
  // because the head is `/m/{boxId}` today and `/mailbox/m/{boxId}` on a sub path deployment.
  // Everything else here is a byte for byte mirror of mailbox/src/core.js, because the reader
  // cannot tell which of the two servers answered and must not have to.
  // -----------------------------------------------------------------------------------------

  const val LATEST_SUFFIX = "/latest.txt"
  const val FRAME_SUFFIX = "/current.frame"
  const val BOOKS_SUFFIX = "/books.txt"
  const val BOOK_PATH_MARKER = "/books/"

  /**
   * The wallpaper pair, added when the sleep screen stopped being direct LAN only.
   *
   * ORDER OF MATCHING MATTERS and is enforced in [MailboxPaths.classify]: a request for
   * `/wallpaper.txt` must be classified as the MANIFEST, never as a body whose id happens to be
   * "wallpaper.txt". The suffix test runs first and the two cannot collide anyway (a path ending
   * `/wallpaper.txt` contains no `/wallpaper/`), but the order is written down because reversing it
   * would produce a 404 for the one endpoint the reader polls every window.
   */
  const val WALLPAPER_SUFFIX = "/wallpaper.txt"
  const val WALLPAPER_PATH_MARKER = "/wallpaper/"

  /** What a wallpaper body is served as. Section 2 uses the same type. */
  const val WALLPAPER_CONTENT_TYPE = "image/bmp"

  /** The two slots, as they appear in the third field of a `wallpaper.txt` line. */
  const val WALLPAPER_TARGET_PRIMARY = "primary"
  const val WALLPAPER_TARGET_SET = "set"

  /**
   * The filename field of a `wallpaper.txt` line for a PRIMARY.
   *
   * A line is `{id} {bytes} {target} {filename}` and the filename is the rest of the line, so a
   * primary still has to put SOMETHING there or a C string walk loses its field count. '-' is that
   * something, which is why a rotation entry literally named '-' is refused by both halves.
   */
  const val WALLPAPER_NO_FILENAME = "-"

  /**
   * Content types, matching `core.js` exactly. [HEALTH_CONTENT_TYPE] carries the same string as
   * [TEXT_CONTENT_TYPE] and stays a separate literal on purpose: it is pinned to the A3 canonical
   * wire block by scripts/reader-link-contract.test.js, so it must not become a reference to
   * something that block does not name.
   */
  const val TEXT_CONTENT_TYPE = "text/plain; charset=utf-8"
  const val FRAME_CONTENT_TYPE = "application/octet-stream"
  const val BOOK_CONTENT_TYPE = "application/epub+zip"
  const val JSON_CONTENT_TYPE = "application/json; charset=utf-8"

  /**
   * `no-store` on every mailbox answer is load bearing on the real server (an intermediary caching
   * `latest.txt` pins the reader on the old id) and free here, so the two servers look identical.
   */
  const val CACHE_CONTROL = "no-store, no-cache, must-revalidate"

  /** Exactly one love note frame, 528 rows x 99 bytes. Anything else the firmware discards. */
  const val NOTE_FRAME_BYTES = 52272L

  /** Section 2 caps, applied to what this module is willing to advertise and serve. */
  const val MAX_BOOK_BYTES = 24L * 1024L * 1024L
  const val MAX_BOOKS = 20
  const val BOOK_ID_MAX_LEN = 64
  const val BOOK_FILENAME_MAX_LEN = 120

  /**
   * Section 2's wallpaper caps. 4 MiB rather than the book's 24: the sleep screen is 528x792 8 bit,
   * so a BMP is about 419 KB and the largest thing the app encodes is about 1.1 MB. A body past this
   * cap is a mis routed payload rather than a wallpaper, and serving it would spend a whole wake
   * window on bytes the firmware then discards.
   */
  const val MAX_WALLPAPER_BYTES = 4L * 1024L * 1024L
  const val MAX_WALLPAPERS = 8
  const val WALLPAPER_ID_MAX_LEN = 64
  const val WALLPAPER_FILENAME_MAX_LEN = 120

  /**
   * The manifest is an index, never a body: 20 books at section 2's caps is under 4 KB of
   * `books.txt`, so a quarter megabyte of JSON is already absurd and a file past it is a bug or a
   * wrong path rather than an outbox.
   */
  const val OUTBOX_MANIFEST_VERSION = 1
  const val OUTBOX_MANIFEST_MAX_BYTES = 256 * 1024
  const val OUTBOX_MAX_ITEMS = 64

  /**
   * A manifest touched within this window is re-parsed even when its size and mtime are unchanged.
   * Filesystem mtimes are coarse, so a rewrite landing in the same millisecond at the same length
   * is invisible to the cheap change test, and the cost of being wrong is serving the note the user
   * just replaced.
   */
  const val OUTBOX_SETTLE_MS = 2_000L

  /**
   * core.js's own cap on a `Range` header worth parsing. It is DELIBERATELY looser than
   * `HttpWire.MAX_RANGE_CHARS` (64), which refuses a longer one with a 400 before it can ever reach
   * the local range math: the number is here so the two servers agree on paper, not because this
   * branch is reachable.
   */
  const val MAX_RANGE_HEADER_CHARS = 128

  /**
   * The merge fetch of the REMOTE `books.txt`, which happens inline while the reader waits. Kept
   * far shorter than the forward budgets: a slow mailbox must degrade to "local books only", not
   * hold the peer connection open for 20 seconds.
   */
  const val REMOTE_MANIFEST_CONNECT_TIMEOUT_MS = 4_000
  const val REMOTE_MANIFEST_READ_TIMEOUT_MS = 4_000
  const val REMOTE_MANIFEST_MAX_BYTES = 16 * 1024

  /**
   * Session modes, reported in `getStatus` and on every proxy event.
   *   upstream — no local items; a pure forwarder, which is what shipped before local serve.
   *   local    — local items and no reachable upstream. THE ZERO INTERNET CASE.
   *   merged   — local items overlaid on a reachable upstream, local winning on a collision.
   *   none     — nothing queued AND no reachable upstream. Not an error: the contract is answered
   *              honestly (empty latest.txt, empty books.txt, 404 for a body) so the reader says
   *              "nothing new" rather than logging a failed sync.
   *
   * `none` was declared by the TS half from the beginning and was NEVER EMITTED here: both this
   * file's [MailboxProxyServer.mode] and the session snapshot answered `upstream` whenever the
   * queue was empty, whether or not there was a route. A session that could reach nothing and hold
   * nothing therefore reported the one mode the UI renders as silence, which is the worst possible
   * answer for the only state the user can actually fix.
   */
  const val MODE_UPSTREAM = "upstream"
  const val MODE_LOCAL = "local"
  const val MODE_MERGED = "merged"
  const val MODE_NONE = "none"

  /** Per request answer source, carried on the activity event. */
  const val SOURCE_LOCAL = "local"
  const val SOURCE_UPSTREAM = "upstream"
  const val SOURCE_MERGED = "merged"

  // -----------------------------------------------------------------------------------------
  // WIFI HANDOVER — the second local only answer, and the one that carries a secret
  //
  // The reader has no keyboard worth typing a WPA2 passphrase on, so the phone hands its network
  // over the peer link instead. This is a HALF OF A WIRE CONTRACT with the firmware exactly like
  // the health answer above: the values live in A3's canonical block and
  // scripts/reader-link-contract.test.js fails when this file and that block disagree.
  //
  //   GET {WIFI_PATH}
  //     200 text/plain; charset=utf-8, body `{ssid}\n{psk}\n` (an EMPTY second line means an open
  //     network), or 404 when nothing is staged or the session was started without
  //     ProxyOptions.wifiSharePath.
  //   DELETE {WIFI_PATH}
  //     200 text/plain; charset=utf-8, body `ok\n`. THE ACK, and what makes this endpoint SINGLE
  //     SERVE: the staged file is deleted before the response is written, so a second GET in the
  //     same session answers 404 and a phone that never hears from JS again still stops offering
  //     the passphrase.
  //
  // FOUR PROPERTIES THIS PATH HAS AND THE FORWARD PATH DOES NOT, each enforced in code rather
  // than promised here:
  //   1. NEVER FORWARDED. HttpWire.classifyTarget answers WIFI before it considers the forward
  //      prefix, so no allowedPathPrefix a session could be configured with can send it upstream.
  //   2. NEVER ACCEPTED FROM UPSTREAM. No code path fetches this path from the mailbox, and the
  //      forward header set is closed, so an upstream answer can never become this one.
  //   3. NEVER LOGGED. MailboxProxyServer suppresses the activity event for this target entirely:
  //      no path, no status, no byte count, no request counter. The only signal is the contentless
  //      ReaderLinkEvents.WIFI_SHARE state below.
  //   4. OPT IN. Absent ProxyOptions.wifiSharePath the endpoint 404s for every method, so a
  //      session that was never asked to share a network cannot be talked into it.
  // -----------------------------------------------------------------------------------------

  const val WIFI_PATH = "/cp-wifi"
  const val WIFI_CONTENT_TYPE = "text/plain; charset=utf-8"
  const val WIFI_ACK_BODY = "ok\n"

  /** 802.11 caps the SSID at 32 BYTES. The JS validator applies the same bound. */
  const val WIFI_SSID_MAX_BYTES = 32
  const val WIFI_PSK_MIN_CHARS = 8
  const val WIFI_PSK_MAX_CHARS = 63

  /**
   * Cap on the staged file. Two lines at the bounds above is under 100 bytes, so a file past this
   * is a wrong path or a bug rather than a credential, and reading it would be reading something
   * this module was never handed.
   */
  const val WIFI_FILE_MAX_BYTES = 1024

  /** Emitted after a GET that put the credential on the wire. Advisory. */
  const val WIFI_STATE_SERVED = "served"

  /** Emitted after the DELETE ack. THE SIGNAL JS WIPES ITS OWN STAGING ON. */
  const val WIFI_STATE_DELIVERED = "delivered"
}

/** Event names. Must match `Events(...)` in [ReaderLinkModule] and the map in index.ts. */
object ReaderLinkEvents {
  const val LINK_STATE = "onLinkState"
  const val PROXY_STATE = "onProxyState"
  const val PROXY_ACTIVITY = "onProxyActivity"
  const val SESSION_END = "onSessionEnd"

  /**
   * WHERE the four contract endpoints are being answered from, emitted at start and again whenever
   * it changes. Its own channel rather than a field on [PROXY_STATE] because the mode changes at
   * moments the proxy lifecycle does not: an upstream that dies mid session flips `merged` to
   * `local` while the listening socket stays perfectly healthy.
   *
   * A NAME MISSING FROM `Events(...)` IS SILENT ON BOTH SIDES. The emit is swallowed by the
   * module's own guard and the JS `addListener` throws and is caught, so the feature simply never
   * reports. scripts/reader-link-contract.test.js compares this object against the module's
   * `Events(...)` list and against the names src/services/reader_link.ts subscribes to.
   */
  const val PROXY_MODE = "onProxyMode"

  /**
   * A body served from the phone's own outbox, emitted once per response that carried local bytes.
   * `complete` is the one field that matters: it says the reader has now received the LAST byte of
   * that item, which is the only delivery confirmation this protocol has (there are no acks
   * anywhere in section 1). JS marks the item delivered on it and prunes.
   */
  const val LOCAL_DELIVERY = "onLocalDelivery"

  /**
   * The WiFi handover, as a STATE WORD AND NOTHING ELSE.
   *
   * The payload is `{ "state": "served" | "delivered" }`. It carries no SSID, no passphrase and no
   * path, and it is the only trace a `/cp-wifi` request leaves anywhere in this module: the
   * activity event, the request counter and the byte counter are all suppressed for that target
   * (see [ProxyContract.WIFI_PATH]). The emit signature MailboxProxyServer is given takes a single
   * String for exactly that reason, so there is no shape in which a credential could ride it even
   * by accident.
   *
   * `delivered` is what the JS half wipes its own staging on. `served` is advisory: the reader has
   * the bytes but has not confirmed it saved them, which is the one distinction that decides
   * whether the passphrase may leave the phone.
   */
  const val WIFI_SHARE = "onWifiShare"
}
