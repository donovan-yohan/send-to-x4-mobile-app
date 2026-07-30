package expo.modules.readerlink

import android.net.Network
import android.os.SystemClock
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URL
import java.util.Collections
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * What the session says when there was no network to even try the mailbox on.
 *
 * A SENTENCE, not a code, because it is rendered verbatim in the app's status line: this string is
 * the entire feedback channel for a session whose failures are otherwise invisible (the reader
 * acks nothing, the mailbox never sees a request, and the radio is not something the user can
 * look at). Kept out of ProxyContract because nothing on the wire depends on it.
 */
private const val NO_UPSTREAM_NOTE = "no internet through this phone, so the mailbox wasn't checked"

/**
 * MailboxProxyServer — the forwarder. Small and boring on purpose (A3: "The forwarder itself is
 * small and must be boring").
 *
 * ------------------------------------------------------------------------------------------
 * HOW THE LISTENER IS BOUND TO THE PEER LINK — the decision A3 leaves open
 * ------------------------------------------------------------------------------------------
 * A3 suggests "`Network.bindSocket()` for the listening socket". There is NO such overload:
 * `android.net.Network` exposes `bindSocket(Socket)`, `bindSocket(DatagramSocket)` and
 * `bindSocket(FileDescriptor)` — a `ServerSocket` has no public FileDescriptor accessor, so
 * that route needs reflection and does not exist as public API.
 *
 * WHAT THIS DOES INSTEAD, and why it is equivalent (better, actually): bind the ServerSocket to
 * the phone's own IPv4 address ON the peer link, read out of
 * `ConnectivityManager.getLinkProperties(peerNetwork).getLinkAddresses()`. A listener bound to a
 * specific local address only accepts connections that arrive for that address, i.e. only on the
 * peer interface; and every accepted socket inherits that local address, so replies egress the
 * peer link with no per-connection binding at all. `bindSocket` on a *client* socket does the
 * same job by picking the route; for a server the local address IS the interface selection.
 *
 * THERE IS NO WILDCARD FALLBACK. Binding 0.0.0.0 would "work" and is exactly the bug worth
 * refusing: the proxy would also listen on the cellular interface, where it is a read-forwarder
 * for anything that can reach the phone. If the peer address cannot be resolved, startProxy
 * fails loudly instead.
 *
 * THE ONE THING ONLY A DEVICE CAN SETTLE, and the escape hatch if it goes the other way. Replies
 * on an ACCEPTED socket follow the connection's own route (the kernel takes it from the inbound
 * SYN's interface), not a fresh mark-based lookup, which is why binding the listener is enough and
 * why `bindSocket` on an accepted socket is not even allowed (it throws once connected). If a real
 * Pixel disagrees and replies leak to the default network, the fallback is
 * `ConnectivityManager.bindProcessToNetwork(peerNetwork)` — and note that this does NOT break the
 * forward the way A3's blanket warning implies, because `upstream.openConnection(url)` binds that
 * connection explicitly and a per-socket binding beats the process default. Try that before
 * anything more elaborate.
 *
 * ------------------------------------------------------------------------------------------
 * UPSTREAM
 * ------------------------------------------------------------------------------------------
 * `upstreamSupplier()` hands back the internet-capable Network (see [UpstreamNetwork]) and every
 * forward is opened with `network.openConnection(url)`, which binds that one connection's
 * sockets to that one network. No `bindProcessToNetwork` anywhere — it is process-wide and would
 * send one of the two directions the wrong way.
 *
 * `Accept-Encoding: identity` is set on every forward and it is NOT cosmetic. Android's
 * HttpURLConnection adds `Accept-Encoding: gzip` by default and transparently decompresses the
 * body — which would make the `Content-Length` / `Content-Range` we echo back describe the
 * COMPRESSED length while we stream the DECOMPRESSED bytes. The reader compares the total in
 * `Content-Range` against the manifest `bytes` on every window (§2/§4.3), so that mismatch would
 * restart the download forever. Setting the header explicitly disables the transparent path.
 *
 * The body is streamed in [ProxyContract.STREAM_CHUNK_BYTES] chunks and never buffered: a book
 * is up to 24 MiB (§2) and materialising it would OOM the phone the same way
 * `uploadLocalFileToCrossPoint` does (see HANDOFF.md's MAX_EPUB_BYTES note).
 *
 * ------------------------------------------------------------------------------------------
 * LOCAL SERVE — the same four endpoints, answered from the phone's own outbox
 * ------------------------------------------------------------------------------------------
 * A3 assumes the phone has cellular, because the proxy forwards. On a plane, on a subway, or on a
 * SIM-less phone on public Wi-Fi there is no upstream at all, and yet the phone is HOLDING the note
 * or the book the user asked to send. [LocalOutbox] is that queue; this class overlays it on the
 * forward.
 *
 * THE RULES, one per endpoint:
 *   - `latest.txt`  local note wins when there is an undelivered one (its id is the body). No local
 *                   note and no upstream is an EMPTY 200, not a 5xx: section 2 makes an empty body
 *                   mean "no note", so the reader shows nothing new instead of logging a failure.
 *   - `current.frame` must pair with whatever `latest.txt` just said, so the choice is LATCHED per
 *                   session. Answering the id locally and the bytes upstream would stage one note's
 *                   pixels under another note's id, and the reader then records that id as shown and
 *                   never re-fetches. That is the exact hazard mailbox/src/core.js is content
 *                   addressed to avoid, and it is unrecoverable, so a latched local id whose item
 *                   has vanished is a 404 and never a forward.
 *   - `books.txt`   union, local lines first (newest first within each side), local winning on an id
 *                   or filename collision, remote extras kept, capped at section 2's MAX_BOOKS so the
 *                   body stays inside the reader's 8 KB read cap. A remote fetch that fails degrades
 *                   to local only rather than failing the window.
 *   - `books/{id}`  local bytes when the id is ours, with FULL Range support, otherwise forwarded.
 *
 * NEVER A 5xx ON THE FOUR CONTRACT ENDPOINTS. With no upstream and nothing local the honest answers
 * are an empty `latest.txt`, an empty `books.txt` and a 404 for a body — all of which the reader
 * already treats as a normal, self healing window.
 *
 * RANGE MATH IS [ByteRanges] AND IT IS LOAD BEARING. A book crosses several reader windows, each
 * asking for the bytes after what it has; one byte wrong strands the download for ever.
 */
internal class MailboxProxyServer(
  private val bindAddress: Inet4Address,
  private val port: Int,
  private val upstreamOrigin: String,
  private val forwardPrefix: String,
  private val upstreamSupplier: () -> Network?,
  private val peerNetworkSupplier: () -> Network?,
  private val outbox: LocalOutbox?,
  private val onActivity: (Map<String, Any?>) -> Unit,
  private val onLocalDelivery: (Map<String, Any?>) -> Unit
) {
  private val stopped = AtomicBoolean(false)
  private val active = AtomicInteger(0)
  private val liveSockets: MutableSet<Socket> =
    Collections.newSetFromMap(ConcurrentHashMap<Socket, Boolean>())

  private var serverSocket: ServerSocket? = null
  private var acceptor: Thread? = null

  private val workers: ExecutorService = Executors.newCachedThreadPool { runnable ->
    Thread(runnable, "reader-link-conn").apply { isDaemon = true }
  }

  /**
   * WHICH NOTE `latest.txt` LAST NAMED, so `current.frame` can serve the matching bytes.
   *
   * NONE is "no `latest.txt` answered yet, or the last one was empty". LOCAL carries the id, and a
   * LOCAL latch is never allowed to fall through to a forward: see the class KDoc on why a
   * mispaired id and frame is the one unrecoverable failure in this protocol.
   */
  private enum class NoteSource { NONE, LOCAL, REMOTE }

  @Volatile
  private var noteSource: NoteSource = NoteSource.NONE

  @Volatile
  private var noteSourceId: String? = null

  val listenAddress: String
    get() = bindAddress.hostAddress ?: "?"

  /**
   * The mode this session is in right now, recomputed because the upstream can drop mid-session.
   *
   * PENDING, never the raw item count. A delivered item is still in the manifest (it stays
   * servable for the retention window so a reader that lost its staging can re-pull) but it is
   * offered in neither `latest.txt` nor `books.txt`, so a queue holding only delivered items has
   * nothing to hand over. Counting it would report `local` to a UI that then tells the user bytes
   * are coming off the phone when none are, and it would disagree with the offline start gate in
   * [ReaderLinkSession], which already uses `pending`.
   */
  fun mode(): String =
    classifyMode(outbox?.snapshot()?.pending ?: 0, resolveUpstream() != null)

  /**
   * The four modes, from the only two facts that decide them.
   *
   * ONE FUNCTION so the start event, every request and `getStatus` cannot disagree — they used to
   * be three copies of the same `when`, and all three answered `upstream` for "nothing queued and
   * no route", which is the one combination the UI needs to narrate. See [ProxyContract.MODE_NONE].
   */
  private fun classifyMode(pending: Int, hasUpstream: Boolean): String = when {
    pending > 0 && hasUpstream -> ProxyContract.MODE_MERGED
    pending > 0 -> ProxyContract.MODE_LOCAL
    hasUpstream -> ProxyContract.MODE_UPSTREAM
    else -> ProxyContract.MODE_NONE
  }

  /** Binds and starts accepting. Throws if the port is taken or the address is not local. */
  fun start() {
    val socket = ServerSocket()
    try {
      socket.reuseAddress = true
      socket.bind(InetSocketAddress(bindAddress, port), ProxyContract.ACCEPT_BACKLOG)
    } catch (e: IOException) {
      try {
        socket.close()
      } catch (ignored: IOException) {
        // nothing to salvage
      }
      throw ProxyStartException(
        "could not listen on ${bindAddress.hostAddress}:$port — ${e.message ?: e.javaClass.simpleName}"
      )
    }
    serverSocket = socket

    val thread = Thread({ acceptLoop(socket) }, "reader-link-accept").apply { isDaemon = true }
    acceptor = thread
    thread.start()
  }

  fun stop() {
    if (!stopped.compareAndSet(false, true)) return
    try {
      serverSocket?.close()
    } catch (ignored: IOException) {
      // closing the listener is what unblocks accept()
    }
    // Close everything in flight so a stalled read/write cannot outlive the session cap.
    for (socket in liveSockets.toList()) {
      closeQuietly(socket)
    }
    liveSockets.clear()
    workers.shutdownNow()
    acceptor?.let { thread ->
      try {
        thread.join(1_000)
      } catch (e: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    acceptor = null
    serverSocket = null
  }

  private fun acceptLoop(socket: ServerSocket) {
    while (!stopped.get()) {
      val client = try {
        socket.accept()
      } catch (e: IOException) {
        // Either stop() closed the listener (normal) or the interface went away.
        break
      }

      // Over the cap: drop without a response. That is the cheapest possible answer and, unlike
      // writing a 503, it cannot block the accept loop on a peer that never reads.
      if (active.get() >= ProxyContract.MAX_CONCURRENT_CONNECTIONS) {
        closeQuietly(client)
        continue
      }

      active.incrementAndGet()
      liveSockets.add(client)
      val submitted = try {
        workers.execute {
          try {
            handle(client)
          } finally {
            liveSockets.remove(client)
            closeQuietly(client)
            active.decrementAndGet()
          }
        }
        true
      } catch (e: RejectedExecutionException) {
        false
      }
      if (!submitted) {
        liveSockets.remove(client)
        closeQuietly(client)
        active.decrementAndGet()
      }
    }
  }

  private fun handle(client: Socket) {
    val startedAt = SystemClock.elapsedRealtime()
    var method = "?"
    var redacted = "?"
    var status = 0
    var bytes = 0L
    var note: String? = null
    var range: String? = null
    var source: String? = null
    var mode: String? = null
    var localId: String? = null
    var localComplete = false
    var upstreamOk: Boolean? = null
    var upstreamError: String? = null

    try {
      client.tcpNoDelay = true
      client.soTimeout = ProxyContract.CLIENT_SOCKET_TIMEOUT_MS

      val input = BufferedInputStream(client.getInputStream(), 4096)
      val out = BufferedOutputStream(client.getOutputStream(), ProxyContract.STREAM_CHUNK_BYTES)

      try {
        val request = HttpWire.parseRequest(input)
        method = request.method
        redacted = HttpWire.redactTarget(request.target)
        range = request.range
        val includeBody = request.method != "HEAD"

        when (HttpWire.classifyTarget(request.target, forwardPrefix)) {
          TargetKind.HEALTH -> {
            status = 200
            val body = ProxyContract.HEALTH_BODY.toByteArray(Charsets.US_ASCII)
            bytes = if (includeBody) body.size.toLong() else 0L
            HttpWire.writeLocalResponse(
              out,
              200,
              body,
              ProxyContract.HEALTH_CONTENT_TYPE,
              includeBody
            )
          }

          TargetKind.FORWARD -> {
            val result = serveMailbox(request, out, includeBody)
            status = result.status
            bytes = result.bytes
            note = result.note
            source = result.source
            mode = result.mode
            localId = result.localId
            localComplete = result.complete
            upstreamOk = result.upstreamOk
            upstreamError = result.upstreamNote
          }
        }
      } catch (e: HttpProtocolException) {
        status = e.status
        note = e.reason
        HttpWire.writeStatusOnly(out, e.status, method != "HEAD")
      }

      out.flush()
    } catch (e: SocketTimeoutException) {
      note = "client read timed out"
    } catch (e: SocketException) {
      note = "connection reset"
    } catch (e: IOException) {
      note = e.message ?: e.javaClass.simpleName
    } catch (e: RuntimeException) {
      // The outer net, and the reason it exists: without it an unchecked throw anywhere below
      // escapes to the `reader-link-conn` thread's default handler, which on Android kills the
      // PROCESS. One malformed upstream header would take the whole app down mid-session with the
      // reader mid-download. The connection is already lost either way; this makes it one dropped
      // window that the activity event still reports, which is what the reader's retry expects.
      note = e.message ?: e.javaClass.simpleName
    } finally {
      onActivity(
        mapOf(
          "method" to method,
          "path" to redacted,
          "status" to status,
          "bytes" to bytes,
          "durationMs" to (SystemClock.elapsedRealtime() - startedAt),
          "range" to range,
          // `note` is this module's name for it; `error` is the key
          // src/services/reader_link.ts reads. Same string, two keys — the two halves have no
          // shared compile step, and a silently-dropped field is not worth one saved word.
          "note" to note,
          "error" to note,
          // Local-serve telemetry, mirrored onto the activity stream the JS layer ALREADY
          // subscribes to. `onLocalDelivery` is the precise channel, but the two halves have no
          // shared compile step, so a delivery must also be visible to a JS build that never
          // learned the new event name.
          "source" to source,
          "mode" to mode,
          "localId" to localId,
          "localComplete" to localComplete,
          // WHETHER THE MAILBOX WAS REACHED, as a fact separate from the answer the reader got.
          //
          // It is separate because the two diverge in exactly the case that was invisible: a
          // contract endpoint whose forward died before a byte was written answers the reader
          // 200-with-an-empty-body or a local merge, and is indistinguishable on every other
          // field from a healthy window. `null` means "no upstream was attempted on this request"
          // (a local note won `latest.txt`), which is NOT the same as "it failed" and must not be
          // reported as one.
          "upstreamOk" to upstreamOk,
          "upstreamError" to upstreamError
        )
      )
    }
  }

  private data class ForwardResult(
    val status: Int,
    val bytes: Long,
    val note: String?,
    val source: String? = null,
    val mode: String? = null,
    val localId: String? = null,
    val complete: Boolean = false,
    /** true reached, false tried and failed, null not attempted. See the activity map above. */
    val upstreamOk: Boolean? = null,
    /** Why the upstream failed, in words a user can read. Only set when [upstreamOk] is false. */
    val upstreamNote: String? = null
  )

  // -----------------------------------------------------------------------------------------
  // Local serve + merge
  // -----------------------------------------------------------------------------------------

  /**
   * The one entry point for a forwardable target. Reads the outbox ONCE per request so every
   * decision inside this answer sees the same set, then routes by contract endpoint.
   */
  private fun serveMailbox(
    request: ProxyRequest,
    out: OutputStream,
    includeBody: Boolean
  ): ForwardResult {
    val snapshot = outbox?.snapshot()
    val upstream = resolveUpstream()
    // PENDING, for the reason spelled out on [mode]: a delivered item is servable but is offered
    // nowhere, so it can never make this session a local or merged one.
    val pending = snapshot?.pending ?: 0
    val mode = classifyMode(pending, upstream != null)
    val target = MailboxPaths.classify(HttpWire.pathOf(request.target))

    val answer = when (target.endpoint) {
      MailboxEndpoint.LATEST -> serveLatest(request, out, includeBody, snapshot, upstream, mode)
      MailboxEndpoint.FRAME -> serveFrame(request, out, includeBody, snapshot, upstream, mode)
      MailboxEndpoint.BOOKS_MANIFEST ->
        serveBooksManifest(request, out, includeBody, snapshot, upstream, mode)
      MailboxEndpoint.BOOK_BODY ->
        serveBookBody(request, out, includeBody, snapshot, upstream, mode, target.bookId)
      MailboxEndpoint.OTHER -> {
        if (upstream == null) {
          // Not a contract endpoint, so there is no honest local answer and no reader behaviour
          // to protect. The four the reader actually polls never reach this branch.
          HttpWire.writeStatusOnly(out, 503, includeBody)
          ForwardResult(503, 0L, "no upstream network", null, mode)
        } else {
          forward(request, out, includeBody, upstream).copy(mode = mode)
        }
      }
    }

    // "There was no network to try" is a distinct fact from "the forward failed", and until now it
    // was reported as neither: every endpoint below silently answered locally and the session had
    // no way to know the mailbox had been skipped rather than consulted. Attributed HERE, once,
    // and only when the endpoint did not already say something more specific.
    return if (upstream == null && answer.upstreamOk == null) {
      answer.copy(upstreamOk = false, upstreamNote = NO_UPSTREAM_NOTE)
    } else {
      answer
    }
  }

  private fun serveLatest(
    request: ProxyRequest,
    out: OutputStream,
    includeBody: Boolean,
    snapshot: OutboxSnapshot?,
    upstream: Network?,
    mode: String
  ): ForwardResult {
    val note = snapshot?.latestNote()
    if (note != null) {
      noteSource = NoteSource.LOCAL
      noteSourceId = note.id
      // The body is the id and NOTHING else: core.js sends no trailing newline so the app can
      // compare it byte for byte, and the firmware trims either way.
      val body = note.id.toByteArray(Charsets.US_ASCII)
      HttpWire.writeLocalResponse(
        out,
        200,
        body,
        ProxyContract.TEXT_CONTENT_TYPE,
        includeBody,
        mailboxHeaders()
      )
      return ForwardResult(
        200,
        if (includeBody) body.size.toLong() else 0L,
        null,
        ProxyContract.SOURCE_LOCAL,
        mode,
        note.id
      )
    }

    if (upstream == null) {
      // ZERO INTERNET, NOTHING QUEUED. An empty body is section 2's "no note", so the reader
      // shows nothing new; a 5xx here would be logged as a failed sync every window.
      noteSource = NoteSource.NONE
      noteSourceId = null
      HttpWire.writeLocalResponse(
        out,
        200,
        ByteArray(0),
        ProxyContract.TEXT_CONTENT_TYPE,
        includeBody,
        mailboxHeaders()
      )
      return ForwardResult(200, 0L, "offline: no queued note", ProxyContract.SOURCE_LOCAL, mode)
    }

    noteSource = NoteSource.REMOTE
    noteSourceId = null
    val forwarded = forward(request, out, includeBody, upstream, deferFailure = true)
    if (forwarded.status != 0) {
      return forwarded.copy(source = ProxyContract.SOURCE_UPSTREAM, mode = mode)
    }

    // The mailbox is unreachable even though a network claimed to have internet. Nothing was
    // written, so the honest answer is still available: an empty body meaning "no note".
    //
    // THIS IS THE WINDOW THAT LOOKED HEALTHY FROM EVERY ANGLE. The reader gets a 200, the activity
    // event carries a 200, the session counts a served request — and the mailbox was never
    // reached. `upstreamOk = false` is the only thing that separates it from a genuinely empty
    // mailbox, and it is what the status line now says out loud.
    noteSource = NoteSource.NONE
    HttpWire.writeLocalResponse(
      out,
      200,
      ByteArray(0),
      ProxyContract.TEXT_CONTENT_TYPE,
      includeBody,
      mailboxHeaders()
    )
    return ForwardResult(
      200,
      0L,
      forwarded.note,
      ProxyContract.SOURCE_LOCAL,
      mode,
      upstreamOk = false,
      upstreamNote = forwarded.upstreamNote ?: forwarded.note
    )
  }

  private fun serveFrame(
    request: ProxyRequest,
    out: OutputStream,
    includeBody: Boolean,
    snapshot: OutboxSnapshot?,
    upstream: Network?,
    mode: String
  ): ForwardResult {
    return when (noteSource) {
      NoteSource.LOCAL -> {
        val id = noteSourceId
        val note = if (id == null) null else snapshot?.note(id)
        if (note != null) {
          serveLocalBody(
            note,
            ProxyContract.FRAME_CONTENT_TYPE,
            null,
            request,
            out,
            includeBody,
            mode
          )
        } else {
          // The id we just handed out is gone (pruned mid-window, or its file moved). A forward
          // here would answer with the REMOTE frame under a LOCAL id, which the reader would stage
          // and then never re-fetch. 404 is self healing: the next window re-reads latest.txt.
          HttpWire.writeStatusOnly(out, 404, includeBody)
          ForwardResult(
            404,
            0L,
            "queued note went away mid-window",
            ProxyContract.SOURCE_LOCAL,
            mode,
            id
          )
        }
      }

      NoteSource.REMOTE -> {
        if (upstream == null) {
          // latest.txt named a REMOTE id and the upstream has since gone. Only the mailbox has
          // those bytes, and serving a local frame under that id is the mispairing this must
          // never do.
          HttpWire.writeStatusOnly(out, 404, includeBody)
          ForwardResult(404, 0L, "upstream went away after latest.txt", null, mode)
        } else {
          val forwarded = forward(request, out, includeBody, upstream, deferFailure = true)
          if (forwarded.status != 0) {
            forwarded.copy(source = ProxyContract.SOURCE_UPSTREAM, mode = mode)
          } else {
            HttpWire.writeStatusOnly(out, 404, includeBody)
            ForwardResult(
              404,
              0L,
              forwarded.note,
              null,
              mode,
              upstreamOk = false,
              upstreamNote = forwarded.upstreamNote ?: forwarded.note
            )
          }
        }
      }

      NoteSource.NONE -> {
        if (upstream != null) {
          val forwarded = forward(request, out, includeBody, upstream, deferFailure = true)
          if (forwarded.status != 0) {
            forwarded.copy(source = ProxyContract.SOURCE_UPSTREAM, mode = mode)
          } else {
            HttpWire.writeStatusOnly(out, 404, includeBody)
            ForwardResult(
              404,
              0L,
              forwarded.note,
              null,
              mode,
              upstreamOk = false,
              upstreamNote = forwarded.upstreamNote ?: forwarded.note
            )
          }
        } else {
          val note = snapshot?.latestNote()
          if (note != null) {
            serveLocalBody(
              note,
              ProxyContract.FRAME_CONTENT_TYPE,
              null,
              request,
              out,
              includeBody,
              mode
            )
          } else {
            HttpWire.writeStatusOnly(out, 404, includeBody)
            ForwardResult(404, 0L, "offline: no queued note", ProxyContract.SOURCE_LOCAL, mode)
          }
        }
      }
    }
  }

  private fun serveBooksManifest(
    request: ProxyRequest,
    out: OutputStream,
    includeBody: Boolean,
    snapshot: OutboxSnapshot?,
    upstream: Network?,
    mode: String
  ): ForwardResult {
    val localLines = snapshot?.bookLines() ?: emptyList()
    var remoteLines: List<String>? = null
    var note: String? = null
    var upstreamOk: Boolean? = null
    var upstreamNote: String? = null
    if (upstream != null) {
      val fetched = fetchRemoteBooksManifest(request, upstream)
      remoteLines = fetched.lines
      if (remoteLines == null) {
        // The forward failed while the reader waits. Answering the local set is a normal window;
        // a 502 would be a failed sync, and an empty answer never DELETES anything on the reader
        // (section 3 only ever downloads ids the manifest names), so nothing is lost either way.
        //
        // BUT IT IS NOT A NORMAL WINDOW FOR THE USER, and that is the distinction this branch used
        // to lose. `books.txt` is polled every window and is the ONE endpoint that touches the
        // upstream unconditionally, so a mailbox that cannot be reached fails here first and every
        // time — silently, relabelled `source: local`, for the whole session.
        note = "remote books.txt unavailable; served local only"
        upstreamOk = false
        upstreamNote = fetched.error ?: note
      } else {
        upstreamOk = true
      }
    }

    val merged = mergeBookLines(localLines, remoteLines ?: emptyList())
    val builder = StringBuilder(merged.size * 64)
    for (line in merged) builder.append(line).append('\n')
    val body = builder.toString().toByteArray(Charsets.US_ASCII)

    HttpWire.writeLocalResponse(
      out,
      200,
      body,
      ProxyContract.TEXT_CONTENT_TYPE,
      includeBody,
      mailboxHeaders()
    )

    val source = when {
      localLines.isEmpty() -> if (remoteLines != null) ProxyContract.SOURCE_UPSTREAM else ProxyContract.SOURCE_LOCAL
      remoteLines.isNullOrEmpty() -> ProxyContract.SOURCE_LOCAL
      else -> ProxyContract.SOURCE_MERGED
    }
    return ForwardResult(
      200,
      if (includeBody) body.size.toLong() else 0L,
      note,
      source,
      mode,
      upstreamOk = upstreamOk,
      upstreamNote = upstreamNote
    )
  }

  private fun serveBookBody(
    request: ProxyRequest,
    out: OutputStream,
    includeBody: Boolean,
    snapshot: OutboxSnapshot?,
    upstream: Network?,
    mode: String,
    bookId: String?
  ): ForwardResult {
    val book = if (bookId == null) null else snapshot?.book(bookId)
    if (book != null) {
      return serveLocalBody(
        book,
        ProxyContract.BOOK_CONTENT_TYPE,
        book.filename,
        request,
        out,
        includeBody,
        mode
      )
    }
    if (upstream != null) {
      val forwarded = forward(request, out, includeBody, upstream, deferFailure = true)
      if (forwarded.status != 0) {
        return forwarded.copy(source = ProxyContract.SOURCE_UPSTREAM, mode = mode)
      }
      HttpWire.writeStatusOnly(out, 404, includeBody)
      return ForwardResult(
        404,
        0L,
        forwarded.note,
        null,
        mode,
        upstreamOk = false,
        upstreamNote = forwarded.upstreamNote ?: forwarded.note
      )
    }
    // Section 2's own answer for an id it cannot produce bytes for: 404, self healing, retried
    // next window. Never a 5xx.
    HttpWire.writeStatusOnly(out, 404, includeBody)
    return ForwardResult(404, 0L, "offline: book not in the outbox", ProxyContract.SOURCE_LOCAL, mode)
  }

  /**
   * Serves one local body, with the full Range answer set: 200, 206 with `Content-Range`, or 416
   * with `Content-Range: bytes` star slash size. The body is streamed from the file in
   * [ProxyContract.STREAM_CHUNK_BYTES] chunks and never held in memory.
   */
  private fun serveLocalBody(
    item: OutboxItem,
    contentType: String,
    dispositionName: String?,
    request: ProxyRequest,
    out: OutputStream,
    includeBody: Boolean,
    mode: String
  ): ForwardResult {
    val size = item.bytes
    val resolved = ByteRanges.resolve(request.range, size)

    if (resolved.unsatisfiable) {
      // The same JSON body core.js sends, so the two servers are indistinguishable on the wire.
      // The reader takes the total out of Content-Range and corrects its offset from it.
      val body = ("{\"ok\":false,\"error\":\"range_not_satisfiable\",\"bytes\":" + size + "}")
        .toByteArray(Charsets.US_ASCII)
      val extra = ArrayList<Pair<String, String>>(4)
      extra.add("Accept-Ranges" to "bytes")
      extra.add("Content-Range" to ("bytes */" + size))
      extra.addAll(mailboxHeaders())
      HttpWire.writeLocalResponse(
        out,
        416,
        body,
        ProxyContract.JSON_CONTENT_TYPE,
        includeBody,
        extra
      )
      return ForwardResult(
        416,
        if (includeBody) body.size.toLong() else 0L,
        "range not satisfiable",
        ProxyContract.SOURCE_LOCAL,
        mode,
        item.id
      )
    }

    val length = resolved.length
    val status = if (resolved.partial) 206 else 200
    val headers = ArrayList<Pair<String, String>>(6)
    headers.add("Content-Type" to contentType)
    // Advertised on the FULL response too: it is how a client discovers that resuming is possible
    // before it has anything to resume.
    headers.add("Accept-Ranges" to "bytes")
    if (dispositionName != null) {
      // Safe to quote unconditionally: LocalOutbox refuses a filename containing a quote, a
      // backslash or any control character, so this cannot break framing.
      headers.add("Content-Disposition" to ("attachment; filename=\"" + dispositionName + "\""))
    }
    if (resolved.partial) {
      headers.add(
        "Content-Range" to ("bytes " + resolved.start + "-" + resolved.end + "/" + size)
      )
    }
    headers.addAll(mailboxHeaders())
    HttpWire.writeHead(out, status, headers, length)

    var written = 0L
    var note: String? = null
    if (includeBody && length > 0L) {
      written = try {
        streamSlice(item.body, resolved.start, length, out)
      } catch (e: IOException) {
        // The head is already on the wire, so this cannot become a 502; the close IS the signal
        // and the reader's Range resume is the recovery path.
        note = "local body read failed: " + (e.message ?: e.javaClass.simpleName)
        0L
      }
      out.flush()
      if (note == null && written != length) {
        note = "short local body: wrote " + written + " of " + length
      }
    }

    // COMPLETE means the reader now holds the last byte of this item. It resumes from where it
    // left off, so reaching the end is the only delivery confirmation this protocol offers.
    val complete = includeBody && written == length && resolved.end == size - 1
    if (includeBody && written > 0L) {
      onLocalDelivery(
        mapOf(
          "id" to item.id,
          "kind" to item.kind.wire,
          "filename" to item.filename,
          "bytes" to size,
          "servedBytes" to written,
          "rangeStart" to resolved.start,
          "rangeEnd" to resolved.end,
          "partial" to resolved.partial,
          "complete" to complete
        )
      )
    }

    return ForwardResult(status, written, note, ProxyContract.SOURCE_LOCAL, mode, item.id, complete)
  }

  private fun streamSlice(file: File, start: Long, length: Long, out: OutputStream): Long {
    var written = 0L
    var remaining = length
    val handle = RandomAccessFile(file, "r")
    try {
      handle.seek(start)
      val buffer = ByteArray(ProxyContract.STREAM_CHUNK_BYTES)
      while (remaining > 0L) {
        val want = if (remaining < buffer.size.toLong()) remaining.toInt() else buffer.size
        val read = handle.read(buffer, 0, want)
        if (read < 0) break
        if (read == 0) continue
        out.write(buffer, 0, read)
        written += read
        remaining -= read
      }
    } finally {
      try {
        handle.close()
      } catch (ignored: IOException) {
        // nothing to salvage
      }
    }
    return written
  }

  /**
   * The outcome of one remote `books.txt` fetch.
   *
   * A bare `List<String>?` was the old return type and it threw away the single most useful string
   * in this module: WHY the mailbox could not be read. Every caller turned the null into "served
   * local only" and the reason — DNS, TLS, a 404 from a wrong boxId, a connect that never
   * completed — died on the stack. It is the same fetch either way; carrying the sentence costs
   * one allocation per window.
   */
  private class RemoteManifest(val lines: List<String>?, val error: String?)

  /**
   * Fetches the REMOTE `books.txt` for the merge.
   *
   * Deliberately not the streaming forward path: the body is a few hundred bytes, it has to be
   * parsed rather than relayed, and the budget is far shorter than a forward's, because the reader
   * is holding a peer connection open while this runs.
   */
  private fun fetchRemoteBooksManifest(request: ProxyRequest, upstream: Network): RemoteManifest {
    val url = try {
      URL(upstreamOrigin + HttpWire.pathOf(request.target))
    } catch (e: Exception) {
      return RemoteManifest(null, "the mailbox address is not a usable URL")
    }
    var connection: HttpURLConnection? = null
    try {
      // DNS RIDES THIS NETWORK TOO. `Network.openConnection` resolves the host on the network it
      // was called on, which is the whole reason the upstream is a `Network` and not a socket
      // factory — and the reason a mailbox name that only exists on the phone's own Wi-Fi can
      // never be reached from here no matter how healthy the connection looks.
      connection = upstream.openConnection(url) as HttpURLConnection
      // Always GET, even when the reader sent HEAD: the merged Content-Length cannot be computed
      // without the remote lines.
      connection.requestMethod = "GET"
      connection.connectTimeout = ProxyContract.REMOTE_MANIFEST_CONNECT_TIMEOUT_MS
      connection.readTimeout = ProxyContract.REMOTE_MANIFEST_READ_TIMEOUT_MS
      applyUpstreamHeaders(connection, null)
      val status = connection.responseCode
      if (status != 200) {
        return RemoteManifest(null, "the mailbox answered $status for books.txt")
      }

      val body = ByteArrayOutputStream(4096)
      val stream = connection.inputStream
        ?: return RemoteManifest(null, "the mailbox sent no body for books.txt")
      val buffer = ByteArray(4096)
      while (true) {
        val read = stream.read(buffer)
        if (read < 0) break
        if (read == 0) continue
        if (body.size() + read > ProxyContract.REMOTE_MANIFEST_MAX_BYTES) {
          return RemoteManifest(null, "the mailbox books.txt is larger than this proxy will read")
        }
        body.write(buffer, 0, read)
      }
      try {
        stream.close()
      } catch (ignored: IOException) {
        // upstream already gave us everything it was going to
      }
      val text = String(body.toByteArray(), Charsets.US_ASCII)
      return RemoteManifest(text.split('\n').map { it.trim() }.filter { it.isNotEmpty() }, null)
    } catch (e: SocketTimeoutException) {
      return RemoteManifest(null, "the mailbox did not answer in time")
    } catch (e: IOException) {
      return RemoteManifest(null, "couldn't reach the mailbox: ${e.message ?: e.javaClass.simpleName}")
    } catch (e: RuntimeException) {
      return RemoteManifest(null, "couldn't reach the mailbox: ${e.message ?: e.javaClass.simpleName}")
    } finally {
      connection?.disconnect()
    }
  }

  /**
   * Union of the two manifests, LOCAL FIRST.
   *
   * Local wins on an id collision (the same book queued and published) and on a filename collision
   * (a re-send under a fresh id). Two entries naming one file is exactly what section 2 refuses on
   * the server, because the reader's promote step would then have two downloads racing for one
   * destination. Remote extras are kept, and the whole thing is capped at section 2's MAX_BOOKS so
   * the body stays inside the reader's 8 KB read cap.
   *
   * Remote lines are re-validated rather than trusted, because this process now owns the framing:
   * a line that does not parse, or whose filename is not what section 2 guarantees, is dropped.
   */
  private fun mergeBookLines(localLines: List<String>, remoteLines: List<String>): List<String> {
    val merged = ArrayList<String>(ProxyContract.MAX_BOOKS)
    val ids = HashSet<String>()
    val names = HashSet<String>()

    for (line in localLines) {
      if (merged.size >= ProxyContract.MAX_BOOKS) break
      val parsed = parseBookLine(line) ?: continue
      if (!ids.add(parsed.first) || !names.add(parsed.second.lowercase(Locale.ROOT))) continue
      merged.add(line)
    }
    for (line in remoteLines) {
      if (merged.size >= ProxyContract.MAX_BOOKS) break
      val parsed = parseBookLine(line) ?: continue
      if (ids.contains(parsed.first)) continue
      if (names.contains(parsed.second.lowercase(Locale.ROOT))) continue
      ids.add(parsed.first)
      names.add(parsed.second.lowercase(Locale.ROOT))
      merged.add(line)
    }
    return merged
  }

  /** `{id} {bytes} {filename}` to (id, filename), or null when the line is not one. */
  private fun parseBookLine(line: String): Pair<String, String>? {
    val firstSpace = line.indexOf(' ')
    if (firstSpace <= 0) return null
    val secondSpace = line.indexOf(' ', firstSpace + 1)
    if (secondSpace <= firstSpace + 1) return null
    val id = line.substring(0, firstSpace)
    val bytes = line.substring(firstSpace + 1, secondSpace)
    val filename = line.substring(secondSpace + 1)
    if (!LocalOutbox.isValidId(id)) return null
    if (bytes.isEmpty() || bytes.any { !it.isDigit() }) return null
    if (!LocalOutbox.isValidBookFilename(filename)) return null
    return id to filename
  }

  /** The headers `mailbox/src/core.js` puts on every answer, so the two servers look the same. */
  private fun mailboxHeaders(): List<Pair<String, String>> = listOf(
    "Cache-Control" to ProxyContract.CACHE_CONTROL,
    "X-Content-Type-Options" to "nosniff",
    "Referrer-Policy" to "no-referrer"
  )

  /**
   * The upstream to forward on, or null when there is none usable. Null is NOT an error here: it
   * is the zero-internet mode, and the callers above turn it into a local answer.
   */
  private fun resolveUpstream(): Network? {
    val upstream = upstreamSupplier() ?: return null
    // Cannot happen given how the two requests are built — asserted anyway, because the
    // alternative failure mode is the invisible one A3 describes.
    if (upstream == peerNetworkSupplier()) return null
    return upstream
  }

  /**
   * THE ONLY headers this proxy ever sends upstream, set in ONE place so both the streaming
   * forward and the manifest merge fetch send exactly this set and nothing else.
   *
   * No Authorization — the write token lives in AsyncStorage for src/services/mailbox_client.ts and
   * is not reachable from here; section 2's reads are protected by the unguessable boxId in the
   * path and need no header. scripts/reader-link-contract.test.js asserts the literal set found in
   * this file, so a new name here is a review event by construction.
   *
   * `Accept-Encoding: identity` is NOT cosmetic: Android's HttpURLConnection otherwise adds gzip
   * and transparently decompresses, which would make the Content-Length and Content-Range we echo
   * describe the COMPRESSED length while we stream the DECOMPRESSED bytes. The reader compares that
   * total against the manifest bytes on every window, so the mismatch would restart the download
   * for ever.
   */
  private fun applyUpstreamHeaders(connection: HttpURLConnection, range: String?) {
    // NO REDIRECT FOLLOWING. This forwarder's whole contract is verbatim passthrough to ONE
    // configured origin, and `HttpURLConnection` would follow a same-scheme cross-HOST 3xx
    // silently — retargeting a read at an origin the user never configured, with nothing on
    // either end able to tell. The mailbox is a static file server that never redirects (§2/§5
    // lists reader-side redirect handling as a known gap), so the honest answer is to relay the
    // 3xx as-is; `Location` is in the passthrough allowlist so at least the answer is complete.
    connection.instanceFollowRedirects = false
    connection.useCaches = false
    connection.doInput = true
    connection.setRequestProperty("Accept-Encoding", "identity")
    connection.setRequestProperty("Accept", "*/*")
    connection.setRequestProperty("User-Agent", ProxyContract.UPSTREAM_USER_AGENT)
    range?.let { connection.setRequestProperty("Range", it) }
  }

  /**
   * [deferFailure] is what lets a contract endpoint fall back to the local outbox.
   *
   * With it set, a failure that happens BEFORE anything was written to the reader writes nothing at
   * all and returns status 0, meaning "no answer was sent, you choose one". The four endpoints the
   * reader polls use it so a dead mailbox degrades to a local answer or to section 2's honest empty
   * or 404, never to a 5xx the reader logs as a failed sync. Once the head IS on the wire there is
   * no choice left, and the connection close is the only signal available.
   */
  private fun forward(
    request: ProxyRequest,
    out: OutputStream,
    includeBody: Boolean,
    upstream: Network,
    deferFailure: Boolean = false
  ): ForwardResult {
    val badUrl = "the mailbox address is not a usable URL"
    val url = try {
      URL(upstreamOrigin + request.target)
    } catch (e: Exception) {
      if (deferFailure) {
        return ForwardResult(0, 0L, "bad upstream url", upstreamOk = false, upstreamNote = badUrl)
      }
      HttpWire.writeStatusOnly(out, 502, includeBody)
      return ForwardResult(502, 0L, "bad upstream url", upstreamOk = false, upstreamNote = badUrl)
    }

    var connection: HttpURLConnection? = null
    var headWritten = false
    try {
      connection = upstream.openConnection(url) as HttpURLConnection
      connection.requestMethod = request.method
      connection.connectTimeout = ProxyContract.UPSTREAM_CONNECT_TIMEOUT_MS
      connection.readTimeout = ProxyContract.UPSTREAM_READ_TIMEOUT_MS
      // The closed header set, plus the no-redirect rule. See [applyUpstreamHeaders].
      applyUpstreamHeaders(connection, request.range)

      val status = connection.responseCode
      val headers = ArrayList<Pair<String, String>>(6)
      var declaredLength = -1L
      for (name in HttpWire.passthroughHeaderNames()) {
        val value = HttpWire.sanitizeHeaderValue(connection.getHeaderField(name)) ?: continue
        if (name == "Content-Length") {
          declaredLength = value.toLongOrNull() ?: -1L
          continue
        }
        headers.add(name to value)
      }

      // Content-Length is re-emitted by writeHead from declaredLength so the two can never
      // disagree. A negative value means upstream used chunked framing and we fall back to
      // close-delimited framing — the mailbox always sends a length, so this is the never-taken
      // branch, but silently dropping the body would be worse.
      HttpWire.writeHead(out, status, headers, declaredLength)
      headWritten = true

      var streamed = 0L
      if (includeBody) {
        val body: InputStream? = if (status >= 400) {
          // getInputStream() throws for >= 400; the error body carries the 416's explanation.
          connection.errorStream
        } else {
          connection.inputStream
        }
        if (body != null) {
          val buffer = ByteArray(ProxyContract.STREAM_CHUNK_BYTES)
          while (true) {
            val read = body.read(buffer)
            if (read < 0) break
            if (read == 0) continue
            out.write(buffer, 0, read)
            streamed += read
          }
          out.flush()
          try {
            body.close()
          } catch (ignored: IOException) {
            // upstream already gave us everything it was going to
          }
        }
      }

      val note = if (declaredLength >= 0 && includeBody && streamed != declaredLength) {
        // The reader's Range resume is exactly the recovery path for this, so it is reported,
        // not repaired.
        "short body: streamed $streamed of $declaredLength"
      } else {
        null
      }
      // The mailbox ANSWERED. Whatever it said (including a 404) is a fact about the mailbox, not
      // about the phone's route to it, so the session's "can this phone reach the mailbox" flag
      // goes true here and only here.
      return ForwardResult(status, streamed, note, upstreamOk = true)
    } catch (e: SocketTimeoutException) {
      val detail = "the mailbox did not answer in time"
      if (deferFailure && !headWritten) {
        return ForwardResult(0, 0L, "upstream timed out", upstreamOk = false, upstreamNote = detail)
      }
      writeGatewayFailure(out, 504, includeBody, headWritten)
      return ForwardResult(504, 0L, "upstream timed out", upstreamOk = false, upstreamNote = detail)
    } catch (e: IOException) {
      val detail = "couldn't reach the mailbox: ${e.message ?: e.javaClass.simpleName}"
      if (deferFailure && !headWritten) {
        return ForwardResult(0, 0L, detail, upstreamOk = false, upstreamNote = detail)
      }
      writeGatewayFailure(out, 502, includeBody, headWritten)
      return ForwardResult(502, 0L, detail, upstreamOk = false, upstreamNote = detail)
    } catch (e: RuntimeException) {
      // NOT SYMMETRY FOR ITS OWN SAKE. `fetchRemoteBooksManifest` has always caught this and this
      // one never did, so an unchecked throw out of `HttpURLConnection` (a malformed header the
      // platform parser rejects, a NumberFormatException out of a bad Content-Length) escaped
      // `handle`'s catch list too and killed the `reader-link-conn` worker outright — a dropped
      // connection mid-session with no event and no status anywhere. Same shape as the checked
      // failures: nothing written means the caller still gets to choose an honest local answer.
      val detail = "the mailbox answered something this proxy could not parse: " +
        (e.message ?: e.javaClass.simpleName)
      if (deferFailure && !headWritten) {
        return ForwardResult(0, 0L, detail, upstreamOk = false, upstreamNote = detail)
      }
      writeGatewayFailure(out, 502, includeBody, headWritten)
      return ForwardResult(502, 0L, detail, upstreamOk = false, upstreamNote = detail)
    } finally {
      connection?.disconnect()
    }
  }

  /**
   * A gateway failure AFTER the head was written cannot be turned into a 502 — the reader is
   * already reading a body, and a second status line would be garbage inside it. In that case
   * the connection close IS the signal, and the reader's Range resume is the recovery path.
   */
  private fun writeGatewayFailure(
    out: OutputStream,
    status: Int,
    includeBody: Boolean,
    headWritten: Boolean
  ) {
    if (headWritten) return
    try {
      HttpWire.writeStatusOnly(out, status, includeBody)
    } catch (ignored: IOException) {
      // the peer is gone
    }
  }

  private fun closeQuietly(socket: Socket) {
    try {
      socket.close()
    } catch (ignored: IOException) {
      // nothing to do
    }
  }
}
