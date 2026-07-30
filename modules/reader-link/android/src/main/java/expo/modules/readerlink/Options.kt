package expo.modules.readerlink

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * Records + validation. Validation lives HERE, in native, not only in the TS wrapper: the TS
 * wrapper is the polite front door but the native side is what talks to the platform, and a
 * bad SSID or a passphrase of the wrong length surfaces from Android as an
 * IllegalArgumentException from a Builder with no useful message.
 *
 * `@Field var` (not `val`) because RecordTypeConverter assigns through `javaField.set(...)` —
 * see node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/records/RecordTypeConverter.kt.
 */
class JoinOptions : Record {
  @Field
  var ssid: String = ProxyContract.READER_AP_SSID

  /**
   * WPA2 PSK, or null/empty for the open AP the firmware ships today. A3 wants a per-device
   * PSK ("Required for the unattended variant"), which is why this is plumbed from a stored
   * setting rather than hardcoded.
   */
  @Field
  var passphrase: String? = null

  /**
   * 0 = no platform timeout (the request stays outstanding until `leaveReaderAp`), which is
   * the mode A3's queued-delivery watcher needs: "do not scan from app code at all: keep the
   * NetworkRequest outstanding ... and let the platform's own matching fire onAvailable".
   */
  @Field
  var timeoutMs: Int = ProxyContract.DEFAULT_JOIN_TIMEOUT_MS
}

class ProxyOptions : Record {
  /**
   * ORIGIN ONLY — `https://host[:port]`, no path, no query, no credentials. The reader sends
   * `/m/{boxId}/...` and the proxy appends it verbatim, so a path here would double up and a
   * userinfo/@ would let a crafted origin retarget the forward. Enforced in [validated].
   */
  @Field
  var upstreamOrigin: String = ""

  /**
   * The same value under the name `src/services/reader_link.ts` uses. Both are accepted because
   * the two halves of this feature have NO shared compile step: a rename on either side produces
   * no error anywhere, just a proxy that starts with an empty upstream and 502s every request —
   * which looks exactly like a dead mailbox. [validated] takes whichever is non-empty and refuses
   * a pair that disagrees.
   */
  @Field
  var mailboxOrigin: String = ""

  /**
   * The ONLY path prefix the forwarder serves. Defaults to A3's `/m/`; the JS layer passes the
   * full base path (`/m/{boxId}/`) for a sub-path mailbox deployment, which also pins the box.
   * A bare `/` is refused — that would be an unrestricted GET relay to the origin for anything
   * that associates with an open AP.
   */
  @Field
  var allowedPathPrefix: String = ProxyContract.FORWARD_PREFIX

  /**
   * Cross-check, not configuration. The reader discovers the proxy by probing a FIXED path; if
   * the JS layer believes in a different one than this module answers, discovery fails silently
   * on a device. Sending it makes the disagreement a startup error instead.
   */
  @Field
  var healthPath: String = ProxyContract.HEALTH_PATH

  @Field
  var port: Int = ProxyContract.DEFAULT_PORT

  @Field
  var sessionMaxMs: Int = ProxyContract.DEFAULT_SESSION_MAX_MS

  /**
   * Upstream network selection — see the long note in [UpstreamNetwork]. Default false =
   * "any internet-capable network", which is cellular whenever the phone gave up its own STA
   * association to join the peer AP (the normal case) and home Wi-Fi under STA+STA
   * concurrency. Setting this true pins TRANSPORT_CELLULAR, which is what A3 describes
   * literally but which also forces the cellular radio up even when a free Wi-Fi upstream
   * exists.
   */
  @Field
  var requireCellularUpstream: Boolean = false

  /**
   * Absolute path (or `file://` URI) of the JS-owned outbox manifest — `outboxManifestPath()` in
   * src/services/outbox.ts. Omit it and the proxy is the pure forwarder it was before.
   *
   * PATHS ONLY, NEVER BODIES. Native opens the manifest and every `bodyPath` it names itself, and
   * re-reads them while the reader polls. A 24 MiB epub pushed across the JS bridge would be the
   * same OOM crash HANDOFF.md records against `uploadLocalFileToCrossPoint`, except with a reader
   * waiting on the socket while it happened.
   */
  @Field
  var outboxManifestPath: String? = null

  /**
   * Absolute path (or `file://` URI) of the two line WiFi credential the phone is handing to the
   * reader — `prepareWifiShareHandover()` in src/services/wifi_share.ts. Omit it and the
   * `/cp-wifi` endpoint does not exist for this session: every method on it answers 404.
   *
   * OPT IN, AND THE OPT IN IS THE POINT. This endpoint is the only one in the module that serves a
   * secret, so a session that was not explicitly asked to share a network must not be talkable
   * into it by anything that associates with the reader's AP.
   *
   * A PATH, NEVER THE VALUES, for the same reason [outboxManifestPath] is: a passphrase in a
   * Record is a passphrase that any validation message, any options dump and any bug report can
   * echo. The file is read by [WifiShareStore], which confines it to this app's own storage and
   * deletes it on the reader's ack.
   */
  @Field
  var wifiSharePath: String? = null
}

internal class InvalidArgumentException(message: String) : CodedException(message)

internal class UnsupportedApiLevelException(message: String) : CodedException(message)

internal class NotJoinedException(message: String) : CodedException(message)

internal class JoinFailedException(message: String) : CodedException(message)

internal class ProxyStartException(message: String) : CodedException(message)

internal class UpstreamUnavailableException(message: String) : CodedException(message)

internal data class ValidatedJoin(
  val ssid: String,
  val passphrase: String?,
  val timeoutMs: Int
)

internal data class ValidatedProxy(
  val upstreamOrigin: String,
  val forwardPrefix: String,
  val port: Int,
  val sessionMaxMs: Int,
  val requireCellularUpstream: Boolean,
  val outboxManifestPath: String?,
  /** Null = this session does not answer `/cp-wifi` at all. See [ProxyOptions.wifiSharePath]. */
  val wifiSharePath: String?
)

internal fun JoinOptions.validated(): ValidatedJoin {
  val trimmedSsid = ssid.trim()
  if (trimmedSsid.isEmpty() || trimmedSsid.length > 32) {
    throw InvalidArgumentException("ssid must be 1..32 characters (got ${trimmedSsid.length})")
  }
  for (c in trimmedSsid) {
    if (c.code < 0x20 || c.code == 0x7F) {
      throw InvalidArgumentException("ssid contains a control character")
    }
  }

  val psk = passphrase?.takeIf { it.isNotEmpty() }
  if (psk != null && (psk.length < 8 || psk.length > 63)) {
    // WifiNetworkSpecifier.Builder.setWpa2Passphrase throws IllegalArgumentException outside
    // this range, and the ESP32 softAP refuses to raise a PSK AP under 8 characters, so a
    // shorter value can only ever be a typo in the settings field.
    throw InvalidArgumentException("passphrase must be 8..63 characters for WPA2 (got ${psk.length})")
  }

  val timeout = when {
    timeoutMs <= 0 -> 0
    timeoutMs < ProxyContract.MIN_JOIN_TIMEOUT_MS -> ProxyContract.MIN_JOIN_TIMEOUT_MS
    timeoutMs > ProxyContract.MAX_JOIN_TIMEOUT_MS -> ProxyContract.MAX_JOIN_TIMEOUT_MS
    else -> timeoutMs
  }

  return ValidatedJoin(trimmedSsid, psk, timeout)
}

/**
 * MUST STAY NO STRICTER THAN THE APP'S OWN MAILBOX-URL CHECK. `checkMailboxBaseUrl`
 * (src/services/mailbox_client.ts) matches the scheme case-INSENSITIVELY and returns the URL as
 * typed, so `HTTPS://mail.example.net/m/BOX` is a valid mailbox base app-wide — publishing, notes
 * and books all work with it. When this pattern refused what that one accepted, `startProxy` threw
 * and the session died as `proxy-failed` while nothing else looked broken.
 *
 * Two relaxations, both to close that gap rather than to accept more shapes in principle:
 *   - IGNORE_CASE (the scheme; per RFC 3986 it is case-insensitive anyway). `describeProxyTarget`
 *     now also lowercases the scheme before it gets here, so this is belt-and-braces on the side
 *     that cannot be compile-checked against the other.
 *   - one optional TRAILING DOT on the host: `https://host.example.net.` is a legal FQDN and the JS
 *     validator accepts it.
 *
 * `scripts/reader-link-contract.test.js` parses this literal out of this file and asserts that every
 * origin `describeProxyTarget` can emit satisfies it — the two validators had nothing tying them
 * together before, which is exactly how they came to disagree.
 */
private val ORIGIN_PATTERN = Regex(
  "^https?://[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\\.?(?::[0-9]{1,5})?$",
  RegexOption.IGNORE_CASE
)

internal fun ProxyOptions.validated(): ValidatedProxy {
  val primary = upstreamOrigin.trim().trimEnd('/')
  val alias = mailboxOrigin.trim().trimEnd('/')
  if (primary.isNotEmpty() && alias.isNotEmpty() && primary != alias) {
    throw InvalidArgumentException(
      "upstreamOrigin (\"$primary\") and mailboxOrigin (\"$alias\") disagree — pass one, or the same value twice"
    )
  }
  val origin = if (primary.isNotEmpty()) primary else alias
  if (origin.isEmpty()) {
    throw InvalidArgumentException("upstreamOrigin is required (e.g. https://mailbox.example.ts.net)")
  }
  if (origin.length > 200) {
    throw InvalidArgumentException("upstreamOrigin is too long")
  }
  if (!ORIGIN_PATTERN.matches(origin)) {
    // Rejects: a path or query ("...ts.net/m/abc"), userinfo ("https://a@b"), an IPv6 literal
    // in brackets (untested here, and the mailbox is always a hostname), a scheme other than
    // http/https, and anything with whitespace or control characters.
    throw InvalidArgumentException(
      "upstreamOrigin must be scheme://host[:port] with no path (got \"$origin\")"
    )
  }

  if (healthPath.trim() != ProxyContract.HEALTH_PATH) {
    throw InvalidArgumentException(
      "healthPath must be \"${ProxyContract.HEALTH_PATH}\" — the reader probes a fixed path and " +
        "\"${healthPath.trim()}\" would never be found"
    )
  }

  val prefix = allowedPathPrefix.trim()
  if (prefix.length < 3 || prefix.length > 128) {
    throw InvalidArgumentException("allowedPathPrefix must be 3..128 characters (got \"$prefix\")")
  }
  if (!prefix.startsWith('/') || !prefix.endsWith('/')) {
    throw InvalidArgumentException("allowedPathPrefix must start and end with '/' (got \"$prefix\")")
  }
  if (prefix.contains("//")) {
    throw InvalidArgumentException("allowedPathPrefix contains an empty segment (\"$prefix\")")
  }
  for (segment in prefix.split('/')) {
    if (segment == "." || segment == "..") {
      throw InvalidArgumentException("allowedPathPrefix contains a traversal segment (\"$prefix\")")
    }
  }
  if (prefix.any { it.isWhitespace() || it == '%' || it == '?' || it == '#' || it.code < 0x20 }) {
    throw InvalidArgumentException("allowedPathPrefix contains an illegal character (\"$prefix\")")
  }

  if (port < 1024 || port > 65535) {
    // <1024 needs privileges the app does not have; the failure would be a bind EACCES that
    // looks like "the proxy just does not work".
    throw InvalidArgumentException("port must be 1024..65535 (got $port)")
  }

  val session = when {
    sessionMaxMs < ProxyContract.MIN_SESSION_MAX_MS -> ProxyContract.MIN_SESSION_MAX_MS
    sessionMaxMs > ProxyContract.MAX_SESSION_MAX_MS -> ProxyContract.MAX_SESSION_MAX_MS
    else -> sessionMaxMs
  }

  // Shape only. Whether the path resolves to a readable file INSIDE the app's own storage is
  // decided by LocalOutbox against the real roots, because only the session holds a Context; what
  // is refused here is the class of value that could never be right, with a message that says so.
  // An absent or empty value is normal and means "no local serve", never an error.
  val manifest = outboxManifestPath?.trim()?.takeIf { it.isNotEmpty() }
  if (manifest != null) {
    if (manifest.length > 1024) {
      throw InvalidArgumentException("outboxManifestPath is too long (${manifest.length} characters)")
    }
    if (!manifest.startsWith("/") && !manifest.startsWith("file:///")) {
      throw InvalidArgumentException(
        "outboxManifestPath must be an absolute path or a file:/// URI (got \"$manifest\")"
      )
    }
    for (c in manifest) {
      if (c.code < 0x20 || c.code == 0x7F) {
        throw InvalidArgumentException("outboxManifestPath contains a control character")
      }
    }
  }

  // Same shape check, same reasoning, and one addition: this value is REFUSED if it is not
  // distinguishable from the manifest, because two endpoints reading one file would let a
  // `books.txt` line be served as a WiFi credential (or the reverse) with nothing to notice. The
  // message names the path and nothing else — there is no secret in it, and the secret the file
  // holds is never read here.
  val wifi = wifiSharePath?.trim()?.takeIf { it.isNotEmpty() }
  if (wifi != null) {
    if (wifi.length > 1024) {
      throw InvalidArgumentException("wifiSharePath is too long (${wifi.length} characters)")
    }
    if (!wifi.startsWith("/") && !wifi.startsWith("file:///")) {
      throw InvalidArgumentException(
        "wifiSharePath must be an absolute path or a file:/// URI (got \"$wifi\")"
      )
    }
    for (c in wifi) {
      if (c.code < 0x20 || c.code == 0x7F) {
        throw InvalidArgumentException("wifiSharePath contains a control character")
      }
    }
    if (manifest != null && wifi == manifest) {
      throw InvalidArgumentException("wifiSharePath and outboxManifestPath must name different files")
    }
  }

  return ValidatedProxy(origin, prefix, port, session, requireCellularUpstream, manifest, wifi)
}
