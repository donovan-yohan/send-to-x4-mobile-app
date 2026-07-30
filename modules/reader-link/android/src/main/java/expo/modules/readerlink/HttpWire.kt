package expo.modules.readerlink

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.Locale

/**
 * HttpWire — a hand-rolled HTTP/1.1 SUBSET, deliberately small enough to audit in one sitting.
 *
 * WHY NOT A LIBRARY: the module ships no new gradle dependencies (see android/build.gradle),
 * and the surface the reader actually needs is two verbs, one optional request header and a
 * fixed set of response headers. NanoHTTPD-shaped generality would be more code than this,
 * not less, and every feature it adds (keep-alive, chunked request bodies, multipart, CGI-ish
 * parameter parsing) is a feature this proxy must NOT have.
 *
 * WHAT IS SUPPORTED
 *   - Request line: `GET|HEAD <origin-form target> HTTP/1.x`. Nothing else.
 *   - One optional `Range: bytes=a-b` request header, passed upstream VERBATIM.
 *   - No request body, ever. `Content-Length: !0` or any `Transfer-Encoding` is a 400.
 *   - One request per connection, always answered with `Connection: close`. A3's reader polls;
 *     keep-alive would buy nothing and would add a second state machine (idle timeouts,
 *     pipelining, half-closed reads) to get wrong.
 *
 * WHAT IS REJECTED, AND WHY EACH ONE MATTERS
 *   - absolute-form targets (`GET http://host/x`): that is the classic open-proxy hole. Only
 *     targets starting with `/` are accepted, which rejects absolute- and authority-form.
 *   - `%` anywhere in the target: every path in §2 (`/m/{boxId}/latest.txt`,
 *     `/m/{boxId}/books/{id}`) is drawn from the unreserved set, so percent-encoding is never
 *     needed — and refusing it removes the whole encoded-traversal / request-smuggling class
 *     instead of trying to normalise it correctly.
 *   - `.` / `..` path segments and `//` runs: same reasoning, one layer down.
 *   - every method except GET and HEAD, and every path except `/cp-proxy` and `/m/…`.
 *
 * Header-name/value handling is ISO-8859-1 (bytes-as-chars) because that is what HTTP/1.1
 * field lines are; the values we forward are ASCII in practice.
 */
internal class HttpProtocolException(val status: Int, val reason: String) : IOException(reason)

/**
 * WIFI is a LOCAL ONLY target, like HEALTH: it is answered from this process and can never become
 * a forward. It is listed before FORWARD here and matched before it in [HttpWire.classifyTarget]
 * because that ordering is the invariant, not a style choice — see [ProxyContract.WIFI_PATH].
 */
internal enum class TargetKind { HEALTH, WIFI, FORWARD }

internal data class ProxyRequest(
  val method: String,
  val target: String,
  val range: String?
)

internal object HttpWire {
  const val MAX_REQUEST_LINE_BYTES = 2048
  const val MAX_HEADER_LINE_BYTES = 1024
  const val MAX_HEADER_COUNT = 32
  const val MAX_HEADER_TOTAL_BYTES = 8192
  const val MAX_TARGET_CHARS = 512
  const val MAX_RANGE_CHARS = 64
  const val MAX_PASSTHROUGH_VALUE_CHARS = 1024

  /**
   * Response headers copied from upstream to the reader. This is an ALLOWLIST and the four
   * range-related entries are load-bearing (A3): "pass `Range` **and** the `206` /
   * `Content-Range` / `416` / `Content-Length` responses back **untouched**. That passthrough
   * is not optional: the reader's resume logic compares the total in `Content-Range` against
   * the manifest's `bytes` ... A proxy that normalizes a `206` into a `200` silently breaks
   * resume."
   *
   * Everything not listed is dropped on purpose:
   *   - `Content-Encoding` / `Transfer-Encoding`: we force `Accept-Encoding: identity` upstream
   *     and re-frame the response ourselves, so echoing either would describe a body we are
   *     not sending.
   *   - `Set-Cookie` / `WWW-Authenticate` / `Authorization`: no credential ever crosses the
   *     peer link in either direction.
   *   - `Connection` / `Keep-Alive`: we always close.
   */
  private val PASSTHROUGH_HEADERS = listOf(
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
    // `Location` is here because the forwarder does NOT follow redirects
    // (MailboxProxyServer sets `instanceFollowRedirects = false`: following one would let a
    // misconfigured mailbox retarget a read at an origin the user never configured). A 3xx is
    // therefore relayed as-is, and a 3xx without its `Location` is a status the reader cannot act
    // on and cannot even log usefully. The value is a URL the reader ignores today — it is not a
    // credential, and `sanitizeHeaderValue` still refuses anything with a control character.
    "Location"
  )

  fun passthroughHeaderNames(): List<String> = PASSTHROUGH_HEADERS

  private fun isAllowedTargetChar(c: Char): Boolean =
    c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' ||
      c == '-' || c == '.' || c == '_' || c == '~' ||
      c == '/' || c == '?' || c == '=' || c == '&' ||
      c == ':' || c == '@' || c == '+' || c == ',' ||
      c == ';' || c == '!' || c == '(' || c == ')' ||
      c == '*' || c == '\''

  /**
   * Reads one CRLF- (or bare-LF-) terminated line, hard-capped at [maxBytes]. A line that
   * never terminates is the cheapest possible DoS against a socket-per-request server, which
   * is why the cap is enforced on the byte count and not after the fact.
   */
  fun readLine(input: InputStream, maxBytes: Int, overflowStatus: Int): String {
    val buf = ByteArrayOutputStream(96)
    while (true) {
      val b = input.read()
      if (b == -1) {
        if (buf.size() == 0) throw HttpProtocolException(400, "closed before a request line")
        throw HttpProtocolException(400, "truncated header line")
      }
      if (b == 0x0A) {
        val bytes = buf.toByteArray()
        val end = if (bytes.isNotEmpty() && bytes[bytes.size - 1] == 0x0D.toByte()) {
          bytes.size - 1
        } else {
          bytes.size
        }
        return String(bytes, 0, end, Charsets.ISO_8859_1)
      }
      if (buf.size() >= maxBytes) {
        throw HttpProtocolException(overflowStatus, "line over $maxBytes bytes")
      }
      buf.write(b)
    }
  }

  fun parseRequest(input: InputStream): ProxyRequest {
    val line = readLine(input, MAX_REQUEST_LINE_BYTES, 414)

    val firstSpace = line.indexOf(' ')
    val lastSpace = line.lastIndexOf(' ')
    if (firstSpace <= 0 || lastSpace <= firstSpace) {
      throw HttpProtocolException(400, "malformed request line")
    }
    val method = line.substring(0, firstSpace)
    val target = line.substring(firstSpace + 1, lastSpace)
    val version = line.substring(lastSpace + 1)

    if (!version.startsWith("HTTP/1.")) {
      throw HttpProtocolException(505, "unsupported HTTP version")
    }
    // SYNTAX BEFORE METHOD, so a percent escape or a traversal segment is refused before anything
    // downstream looks at the path — including the one method gate below that does.
    validateTargetSyntax(target)
    // GET|HEAD only. A3: "accept GET and HEAD on /m/* and nothing else ... The reader never
    // publishes — HttpDownloader only ever issues GET". A write reaching the mailbox through
    // this module is impossible by construction, not by policy.
    //
    // DELETE IS THE ONE EXCEPTION AND IT IS PINNED TO ONE LITERAL LOCAL PATH. The WiFi handover
    // needs an ack, and an ack is a write; without one the phone would go on offering a passphrase
    // the reader already holds. It is admitted here ONLY for ProxyContract.WIFI_PATH, which
    // classifyTarget answers locally and which no forward prefix can ever reach, so the mailbox
    // still cannot see a method other than GET or HEAD from this module. Every other target,
    // including /cp-proxy and everything under the forward prefix, still refuses it.
    if (method != "GET" && method != "HEAD") {
      val wifiAck = method == "DELETE" && pathOf(target) == ProxyContract.WIFI_PATH
      if (!wifiAck) throw HttpProtocolException(405, "method not allowed")
    }

    var range: String? = null
    var headerCount = 0
    var headerBytes = 0
    while (true) {
      val header = readLine(input, MAX_HEADER_LINE_BYTES, 431)
      if (header.isEmpty()) break

      headerCount += 1
      headerBytes += header.length + 2
      if (headerCount > MAX_HEADER_COUNT) throw HttpProtocolException(431, "too many headers")
      if (headerBytes > MAX_HEADER_TOTAL_BYTES) throw HttpProtocolException(431, "headers too large")

      val colon = header.indexOf(':')
      if (colon <= 0) throw HttpProtocolException(400, "malformed header line")
      val name = header.substring(0, colon).trim().lowercase(Locale.ROOT)
      val value = header.substring(colon + 1).trim()

      when (name) {
        "range" -> {
          if (range != null) throw HttpProtocolException(400, "duplicate Range header")
          range = validateRange(value)
        }
        "content-length" ->
          if (value != "0") throw HttpProtocolException(400, "request body not accepted")
        "transfer-encoding" ->
          throw HttpProtocolException(400, "request body not accepted")
        "expect" ->
          throw HttpProtocolException(417, "Expect not supported")
        // Every other inbound header is IGNORED, not forwarded. Host, User-Agent, Cookie and
        // above all Authorization stop here: the write token is not in this process's reach
        // from the peer link, and echoing an inbound Authorization upstream would turn the
        // proxy into a credential relay.
      }
    }

    return ProxyRequest(method, target, range)
  }

  /**
   * Validates the shape of a single byte-range and returns the ORIGINAL string. "Verbatim
   * passthrough" and "validated" are not in tension here: every legal single range is
   * forwarded byte-for-byte, and the illegal shapes are refused rather than dropped — dropping
   * a Range is exactly what silently breaks the reader's resume.
   */
  private fun validateRange(value: String): String {
    if (value.length > MAX_RANGE_CHARS) throw HttpProtocolException(400, "Range header too long")
    if (!value.startsWith("bytes=", ignoreCase = true)) {
      throw HttpProtocolException(400, "only byte ranges are supported")
    }
    val spec = value.substring(6).trim()
    if (spec.contains(',')) {
      // A multipart/byteranges reply would be a second body format for the reader to parse.
      // §3 never asks for one.
      throw HttpProtocolException(400, "multi-range requests are not supported")
    }
    val dash = spec.indexOf('-')
    if (dash < 0) throw HttpProtocolException(400, "malformed Range header")
    val first = spec.substring(0, dash)
    val last = spec.substring(dash + 1)
    if (first.isEmpty() && last.isEmpty()) throw HttpProtocolException(400, "empty Range")
    if (first.any { !it.isDigit() } || last.any { !it.isDigit() }) {
      throw HttpProtocolException(400, "malformed Range header")
    }
    return value
  }

  private fun validateTargetSyntax(target: String) {
    if (target.isEmpty() || target[0] != '/') {
      throw HttpProtocolException(400, "only origin-form targets are accepted")
    }
    if (target.length > MAX_TARGET_CHARS) throw HttpProtocolException(414, "target too long")
    for (c in target) {
      if (!isAllowedTargetChar(c)) throw HttpProtocolException(400, "illegal character in target")
    }
    val path = pathOf(target)
    if (path.contains("//")) throw HttpProtocolException(400, "malformed target")
    for (segment in path.split('/')) {
      if (segment == "." || segment == "..") throw HttpProtocolException(400, "traversal rejected")
    }
  }

  fun pathOf(target: String): String {
    val q = target.indexOf('?')
    return if (q >= 0) target.substring(0, q) else target
  }

  /**
   * [forwardPrefix] is a parameter, not a constant. `/m/` is A3's literal rule and the default,
   * but a mailbox mounted under a sub-path (`https://host/mailbox/m/{boxId}`) would then be
   * refused by its own proxy — and when the JS layer passes the full base path instead, the
   * prefix pins the box as well, which is strictly TIGHTER than `/m/…`.
   */
  fun classifyTarget(target: String, forwardPrefix: String): TargetKind {
    val path = pathOf(target)
    if (path == ProxyContract.HEALTH_PATH) return TargetKind.HEALTH
    // BEFORE THE FORWARD TEST, and that is the whole of the "never forwarded" guarantee for the
    // WiFi handover: whatever prefix a session was configured with, an exact match on this literal
    // path has already been answered locally by the time the prefix is consulted. Both local paths
    // are exact-match, so neither can be shadowed by a longer prefix either.
    if (path == ProxyContract.WIFI_PATH) return TargetKind.WIFI
    if (path.length > forwardPrefix.length && path.startsWith(forwardPrefix)) {
      return TargetKind.FORWARD
    }
    throw HttpProtocolException(404, "not found")
  }

  /**
   * Strips the capability segment out of a target before it is handed to JS as telemetry.
   * `boxId` IS the read capability for the entire mailbox (§2), so a status line, a console log
   * or a crash report must never carry it.
   *
   * Anchored on `/m/` ANYWHERE in the path rather than only at the start, because the sub-path
   * deployment above puts the capability at `/mailbox/m/{boxId}/...`. A path with no `/m/` at all
   * is redacted wholesale — an unrecognised shape is exactly when guessing where the secret is
   * would be wrong.
   */
  fun redactTarget(target: String): String {
    val marker = target.indexOf(ProxyContract.FORWARD_PREFIX)
    if (marker < 0) return "/*"
    val head = target.substring(0, marker + ProxyContract.FORWARD_PREFIX.length)
    val rest = target.substring(marker + ProxyContract.FORWARD_PREFIX.length)
    val slash = rest.indexOf('/')
    return if (slash < 0) head + "*" else head + "*" + rest.substring(slash)
  }

  /** Drops any upstream header value that could inject a header or a body boundary. */
  fun sanitizeHeaderValue(value: String?): String? {
    if (value == null) return null
    if (value.isEmpty() || value.length > MAX_PASSTHROUGH_VALUE_CHARS) return null
    for (c in value) {
      if (c.code < 0x20 || c.code == 0x7F) return null
    }
    return value
  }

  fun reasonPhrase(status: Int): String = when (status) {
    200 -> "OK"
    204 -> "No Content"
    206 -> "Partial Content"
    304 -> "Not Modified"
    400 -> "Bad Request"
    403 -> "Forbidden"
    404 -> "Not Found"
    405 -> "Method Not Allowed"
    414 -> "URI Too Long"
    416 -> "Range Not Satisfiable"
    417 -> "Expectation Failed"
    431 -> "Request Header Fields Too Large"
    500 -> "Internal Server Error"
    502 -> "Bad Gateway"
    503 -> "Service Unavailable"
    504 -> "Gateway Timeout"
    505 -> "HTTP Version Not Supported"
    else -> if (status in 200..299) "OK" else "Error"
  }

  /**
   * Writes the status line + headers. [contentLength] < 0 means "no Content-Length" — the body
   * is then delimited by the connection close, which is legal HTTP/1.1 for a response and is
   * the only honest answer when upstream itself used chunked framing.
   */
  fun writeHead(
    out: OutputStream,
    status: Int,
    headers: List<Pair<String, String>>,
    contentLength: Long
  ) {
    val sb = StringBuilder(256)
    sb.append("HTTP/1.1 ").append(status).append(' ').append(reasonPhrase(status)).append("\r\n")
    for ((name, value) in headers) {
      sb.append(name).append(": ").append(value).append("\r\n")
    }
    if (contentLength >= 0) {
      sb.append("Content-Length: ").append(contentLength).append("\r\n")
    }
    sb.append("Connection: close\r\n\r\n")
    out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
  }

  /**
   * A locally generated response — the health answer and every refusal. The body is a fixed
   * short string built from OUR OWN literals; nothing from the request is echoed back, so a
   * malformed request cannot get its bytes reflected.
   */
  fun writeLocalResponse(
    out: OutputStream,
    status: Int,
    body: ByteArray,
    contentType: String,
    includeBody: Boolean,
    extraHeaders: List<Pair<String, String>> = emptyList()
  ) {
    val headers = ArrayList<Pair<String, String>>(2 + extraHeaders.size)
    headers.add("Content-Type" to contentType)
    headers.addAll(extraHeaders)
    writeHead(out, status, headers, body.size.toLong())
    if (includeBody) out.write(body)
    out.flush()
  }

  fun writeStatusOnly(out: OutputStream, status: Int, includeBody: Boolean) {
    val body = (status.toString() + " " + reasonPhrase(status) + "\n").toByteArray(Charsets.US_ASCII)
    val extra: List<Pair<String, String>> =
      if (status == 405) listOf("Allow" to "GET, HEAD") else emptyList()
    writeLocalResponse(out, status, body, "text/plain; charset=utf-8", includeBody, extra)
  }
}
