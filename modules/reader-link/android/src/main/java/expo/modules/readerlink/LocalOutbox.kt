package expo.modules.readerlink

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.Locale
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * LocalOutbox — the phone's own copy of what it is trying to hand the reader, read straight off
 * disk by the proxy so a sync needs NO INTERNET AT ALL.
 *
 * WHY THIS EXISTS. Every path in Appendix A3 terminates at the mailbox: the proxy joins the
 * reader's AP and forwards reads upstream, so the phone still needs cellular. On a plane, on a
 * subway, or on a public network with no SIM, the forward fails and the reader is told nothing is
 * there. Yet the phone is HOLDING the bytes the user asked to send. This class is the source that
 * lets the proxy answer the four contract endpoints from those bytes.
 *
 * OWNERSHIP SPLIT, and it is deliberate. JS owns persistence and policy (src/services/outbox.ts):
 * it writes the bodies, mints the ids, keeps the index, marks delivery and prunes. Kotlin owns
 * nothing but READING: one small JSON manifest plus the body files it names. NO BODY EVER CROSSES
 * THE JS BRIDGE — a 24 MiB epub materialised as a base64 string is the OOM crash HANDOFF.md
 * records against `uploadLocalFileToCrossPoint`, and it would be strictly worse here because the
 * reader is waiting on a socket while it happens.
 *
 * MANIFEST SHAPE (version 1), written by JS, read here:
 *
 *   {
 *     "version": 1,
 *     "items": [
 *       { "id": "01JQ...", "kind": "note", "bytes": 52272,
 *         "bodyPath": "file:///data/user/0/pkg/files/outbox/01JQ.frame",
 *         "queuedAt": 1753900000000 },
 *       { "id": "01JR...", "kind": "book", "filename": "Piranesi.epub", "bytes": 402118,
 *         "bodyPath": "/data/user/0/pkg/files/outbox/01JR.epub",
 *         "queuedAt": 1753900100000, "deliveredAt": 1753900200000 },
 *       { "id": "wp-01JS...", "kind": "wallpaper", "target": "set", "filename": "dune-2026.bmp",
 *         "bytes": 418992, "bodyPath": "/data/user/0/pkg/files/outbox/wallpaper-wp-01JS.bmp",
 *         "queuedAt": 1753900300000 }
 *     ]
 *   }
 *
 * ORDER IS PART OF THE CONTRACT: items are NEWEST LAST, so the latest note is the last note entry.
 * Books are emitted newest-first in `books.txt` per section 2, which is this list reversed.
 * Wallpapers are emitted NEWEST LAST in `wallpaper.txt` — this list's own order — because a reader
 * applies them one after another and the last one applied wins the `/sleep.bmp` slot.
 *
 * THE MANIFEST MUST BE WRITTEN ATOMICALLY (temp file plus rename). This class re-reads it while the
 * reader is polling, so a partial write would be parsed as garbage. A parse failure is never fatal:
 * the snapshot degrades to "no local items" carrying an error string, and the proxy falls back to
 * forwarding, which is exactly today's behaviour.
 *
 * EVERY ENTRY IS RE-VALIDATED ON READ, and an entry that fails ANY check is dropped rather than
 * repaired. Section 2 makes the same choice on the server for the same reason: a manifest line the
 * server cannot actually serve strands the reader in a resume loop, and one it can serve but whose
 * name is forged breaks the line framing for every entry after it. Dropped entries are counted, not
 * hidden, so `getStatus` can say "3 queued, 1 unusable".
 *
 * CONFINEMENT. `bodyPath` names a file this process then serves onto an OPEN Wi-Fi link, so it is
 * resolved and canonicalised (which also resolves symlinks) and refused unless it lands inside one
 * of the app's own directories. The manifest is written by our own JS, so this is not defence
 * against a hostile author; it is defence against a bug that turns the proxy into a file server for
 * the phone.
 *
 * API PROVENANCE (Kotlin here is not compile verified in this workflow):
 *   - `org.json.JSONObject` / `JSONArray` / `JSONException` ship in the Android framework
 *     (android.jar, since API 1). No gradle dependency is added by this file.
 *   - `File.canonicalFile`, `File.isFile`, `File.length`, `File.lastModified`, `File.canRead`,
 *     `java.io.RandomAccessFile` are java.io, present on every API level this module targets.
 *   - `kotlin.io.readText` is kotlin stdlib, already on the module classpath.
 */
internal enum class OutboxKind(val wire: String) {
  NOTE("note"),
  BOOK("book"),
  WALLPAPER("wallpaper")
}

internal data class OutboxItem(
  val id: String,
  val kind: OutboxKind,
  /** Books and `set` wallpapers always carry one; notes and `primary` wallpapers never do. */
  val filename: String?,
  /**
   * Wallpapers only: `primary` for the single `/sleep.bmp` slot, `set` for one entry of the
   * `/.sleep` rotation. Null for every other kind.
   *
   * NEVER DEFAULTED. An entry whose target cannot be read is DROPPED rather than guessed into
   * `primary`, because `primary` overwrites the one file the firmware prefers over everything else
   * and a wrong guess replaces a sleep screen the user never asked to replace.
   */
  val target: String?,
  /** The file's ACTUAL length, already checked against the manifest's `bytes`. */
  val bytes: Long,
  val body: File,
  val queuedAt: Long,
  /** JS has already recorded a delivery for this item; it stays servable, but it is not "pending". */
  val delivered: Boolean
)

/**
 * One parse of the manifest. Immutable, so a request can hold it for the whole of its answer and
 * never see the set change under it mid response.
 */
internal data class OutboxSnapshot(
  val items: List<OutboxItem>,
  /** Entries the manifest named that this class refused to serve. */
  val skipped: Int,
  val error: String?,
  val readAtMs: Long
) {
  val notes: List<OutboxItem>
    get() = items.filter { it.kind == OutboxKind.NOTE }

  val books: List<OutboxItem>
    get() = items.filter { it.kind == OutboxKind.BOOK }

  val wallpapers: List<OutboxItem>
    get() = items.filter { it.kind == OutboxKind.WALLPAPER }

  val pending: Int
    get() = items.count { !it.delivered }

  /**
   * The note `latest.txt` should name: the newest one JS has NOT already recorded as delivered.
   *
   * Skipping delivered items is what stops a note the reader already has from masking a NEWER
   * remote note for ever. The reader dedups on id, so re-serving would be harmless on the panel,
   * but the mask would not be: while a local note is offered, the remote one is never asked for.
   */
  fun latestNote(): OutboxItem? = items.lastOrNull { it.kind == OutboxKind.NOTE && !it.delivered }

  /** Exact-id lookup, including delivered items: a resume in flight must not lose its body. */
  fun note(id: String): OutboxItem? = items.firstOrNull { it.kind == OutboxKind.NOTE && it.id == id }

  fun book(id: String): OutboxItem? = items.firstOrNull { it.kind == OutboxKind.BOOK && it.id == id }

  /** Exact id lookup, including delivered items, for the reason [book] includes them. */
  fun wallpaper(id: String): OutboxItem? =
    items.firstOrNull { it.kind == OutboxKind.WALLPAPER && it.id == id }

  /**
   * Local `books.txt` lines, NEWEST FIRST (section 2), without their terminating LF.
   * `{id} {bytes} {filename}` — id and bytes contain no space by construction and the filename is
   * the rest of the line.
   *
   * DELIVERED BOOKS ARE OMITTED, exactly as [latestNote] omits a delivered note, because the two
   * halves of the contract say the same thing: `deliveredAt` present means leave the item out of
   * `latest.txt` and `books.txt` while still ANSWERING `books/{id}` for it (which [book] does) so
   * an in flight Range resume and a re-pull inside the retention window both still find their
   * body. Listing it anyway costs one of the MAX_BOOKS slots for the whole 24 h delivered grace
   * and, because local wins on a lowercased filename collision in the merge, suppresses the
   * REMOTE listing of the same title for that long.
   */
  fun bookLines(): List<String> =
    books.filter { !it.delivered }.reversed().map { item ->
      item.id + " " + item.bytes + " " + (item.filename ?: "")
    }

  /**
   * Local `wallpaper.txt` lines, NEWEST LAST, without their terminating LF.
   * `{id} {bytes} {target} {filename}` with '-' in the filename position for a primary.
   *
   * NEWEST LAST IS THE OPPOSITE OF [bookLines] AND THAT IS THE POINT. Books are a set the reader
   * picks from; wallpapers are APPLIED, one after another, and the last one applied wins the
   * `/sleep.bmp` slot. A reader that walks this list in order therefore finishes on the newest
   * primary, which is what the user last asked for. Reversing this would leave the panel showing
   * the OLDEST picture in the queue.
   *
   * ONLY THE LAST PENDING PRIMARY IS OFFERED. The queue can hold several (a JS side collapse exists
   * but is best effort, and a merge with the remote manifest can reintroduce one), and every extra
   * one is a whole BMP the reader pulls inside a battery budgeted window purely to overwrite it a
   * window later. Rotation entries are all kept: each is a distinct file the user chose to add.
   *
   * DELIVERED ITEMS ARE OMITTED, exactly as in [bookLines] and [latestNote], while [wallpaper]
   * still answers for them so an in flight Range resume keeps its body.
   */
  fun wallpaperLines(): List<String> {
    val pending = wallpapers.filter { !it.delivered }
    val lastPrimaryIndex = pending.indexOfLast { it.target == ProxyContract.WALLPAPER_TARGET_PRIMARY }
    val out = ArrayList<String>(pending.size)
    for ((index, item) in pending.withIndex()) {
      if (item.target == ProxyContract.WALLPAPER_TARGET_PRIMARY && index != lastPrimaryIndex) continue
      val name = if (item.target == ProxyContract.WALLPAPER_TARGET_SET) {
        item.filename ?: ProxyContract.WALLPAPER_NO_FILENAME
      } else {
        ProxyContract.WALLPAPER_NO_FILENAME
      }
      out.add(item.id + " " + item.bytes + " " + item.target + " " + name)
    }
    return out
  }

  companion object {
    fun empty(error: String?): OutboxSnapshot =
      OutboxSnapshot(emptyList(), 0, error, System.currentTimeMillis())
  }
}

internal class LocalOutbox(
  rawManifestPath: String,
  private val roots: List<File>
) {
  private val lock = Any()
  private var cached: OutboxSnapshot = OutboxSnapshot.empty(null)
  private var cachedStamp: String? = null
  private var cachedAt: Long = 0L

  /**
   * The manifest goes through the SAME confinement as the bodies it names: a `file://` URI is
   * accepted, percent escapes are decoded, the result is canonicalised, and anything outside the
   * app's own storage is refused. Null means refused, and then this outbox is simply inert.
   */
  private val manifestFile: File? = resolveWithinRoots(rawManifestPath)

  val manifestPath: String
    get() = manifestFile?.path ?: ""

  /**
   * The current manifest, re-read when the file has changed.
   *
   * The cheap change test is `lastModified` plus `length`, which cannot see a rewrite that lands in
   * the same millisecond at the same size. So a manifest touched within
   * [ProxyContract.OUTBOX_SETTLE_MS] is ALWAYS re-parsed: the file is a few hundred bytes, the
   * reader polls every few seconds, and the alternative is serving a note the user just replaced.
   */
  fun snapshot(): OutboxSnapshot {
    val file = manifestFile
      ?: return OutboxSnapshot.empty(
        "the outbox manifest path is outside this app's own storage and was refused"
      )
    synchronized(lock) {
      val now = System.currentTimeMillis()
      val stamp = file.lastModified().toString() + ":" + file.length()
      val settled = now - file.lastModified() > ProxyContract.OUTBOX_SETTLE_MS
      if (stamp == cachedStamp && settled && cachedAt != 0L) return cached
      val parsed = parse(file, now)
      cached = parsed
      cachedStamp = stamp
      cachedAt = now
      return parsed
    }
  }

  /** Forces the next [snapshot] to re-read. Used at session start. */
  fun invalidate() {
    synchronized(lock) {
      cachedStamp = null
      cachedAt = 0L
    }
  }

  private fun parse(file: File, now: Long): OutboxSnapshot {
    if (!file.isFile) {
      // Not an error: JS writes the manifest the first time something is queued, and a session
      // started before that is simply a plain forwarder.
      return OutboxSnapshot(emptyList(), 0, null, now)
    }
    val length = file.length()
    if (length <= 0L) return OutboxSnapshot(emptyList(), 0, null, now)
    if (length > ProxyContract.OUTBOX_MANIFEST_MAX_BYTES) {
      return OutboxSnapshot(
        emptyList(),
        0,
        "outbox manifest is " + length + " bytes, over the " +
          ProxyContract.OUTBOX_MANIFEST_MAX_BYTES + " byte cap",
        now
      )
    }

    val text = try {
      file.readText(Charsets.UTF_8)
    } catch (e: IOException) {
      return OutboxSnapshot(
        emptyList(),
        0,
        "outbox manifest unreadable: " + (e.message ?: e.javaClass.simpleName),
        now
      )
    }

    val root = try {
      JSONObject(text)
    } catch (e: JSONException) {
      // A torn read of a manifest being rewritten looks exactly like this. Reporting it and
      // serving nothing local is safe; the next poll re-reads.
      return OutboxSnapshot(emptyList(), 0, "outbox manifest is not valid JSON", now)
    }

    // ABSENT IS UNSUPPORTED, NOT VERSION 1. `optInt(name, fallback)` would default a manifest with
    // no `version` key to this build's own version and then parse it as though it had claimed to be
    // one, which is exactly backwards: the contract says an absent or unknown version means "no
    // local items". The cases that produces are real — a future writer that renames the field, or a
    // stale path pointing at some other JSON file inside the sandbox — and interpreting either as a
    // v1 manifest is how a foreign document ends up being served onto an open Wi-Fi link.
    val declaredVersion = root.opt("version")
    val version = (declaredVersion as? Number)?.toInt()
    if (version != ProxyContract.OUTBOX_MANIFEST_VERSION) {
      return OutboxSnapshot(
        emptyList(),
        0,
        "outbox manifest version " + (declaredVersion?.toString() ?: "(absent)") +
          " is not supported by this build",
        now
      )
    }

    val array: JSONArray = root.optJSONArray("items") ?: JSONArray()
    val items = ArrayList<OutboxItem>(minOf(array.length(), ProxyContract.OUTBOX_MAX_ITEMS))
    var skipped = 0
    val seen = HashSet<String>()
    for (index in 0 until array.length()) {
      if (items.size >= ProxyContract.OUTBOX_MAX_ITEMS) {
        skipped += array.length() - index
        break
      }
      val obj = array.optJSONObject(index)
      if (obj == null) {
        skipped += 1
        continue
      }
      val item = itemOf(obj)
      if (item == null || !seen.add(item.kind.wire + ":" + item.id)) {
        skipped += 1
        continue
      }
      items.add(item)
    }

    return OutboxSnapshot(items, skipped, null, now)
  }

  private fun itemOf(obj: JSONObject): OutboxItem? {
    val id = stringField(obj, "id") ?: return null
    if (!isValidId(id)) return null

    val kind = when (stringField(obj, "kind")?.lowercase(Locale.ROOT)) {
      OutboxKind.NOTE.wire -> OutboxKind.NOTE
      OutboxKind.BOOK.wire -> OutboxKind.BOOK
      OutboxKind.WALLPAPER.wire -> OutboxKind.WALLPAPER
      else -> return null
    }

    val declared = obj.optLong("bytes", -1L)
    if (declared <= 0L) return null

    val bodyPath = stringField(obj, "bodyPath") ?: return null
    val body = resolveWithinRoots(bodyPath) ?: return null
    if (!body.isFile || !body.canRead()) return null

    // The FILE is the truth, and a disagreement is a dropped entry rather than a corrected one.
    // Section 2 answers `corrupt_book` with a 500 for the same mismatch; dropping is the local
    // equivalent that still leaves the reader a normal, self healing window: the entry is simply
    // not offered until JS fixes it.
    val actual = body.length()
    if (actual != declared) return null

    val filename = stringField(obj, "filename")
    var target: String? = null
    when (kind) {
      OutboxKind.NOTE ->
        // Exactly one frame, or the firmware downloads it over a battery budgeted window and then
        // discards it for being the wrong size.
        if (actual != ProxyContract.NOTE_FRAME_BYTES) return null

      OutboxKind.BOOK -> {
        if (filename == null || !isValidBookFilename(filename)) return null
        if (actual > ProxyContract.MAX_BOOK_BYTES) return null
      }

      OutboxKind.WALLPAPER -> {
        // ABSENT OR UNKNOWN TARGET IS A DROPPED ENTRY, never a default. See OutboxItem.target.
        val declaredTarget = stringField(obj, "target")?.lowercase(Locale.ROOT)
        if (declaredTarget != ProxyContract.WALLPAPER_TARGET_PRIMARY &&
          declaredTarget != ProxyContract.WALLPAPER_TARGET_SET
        ) {
          return null
        }
        // A rotation entry IS its filename; a primary has none, and one supplied anyway is
        // discarded rather than carried, so the line this produces cannot describe a file the
        // reader would create in the wrong place.
        if (declaredTarget == ProxyContract.WALLPAPER_TARGET_SET) {
          if (filename == null || !isValidWallpaperFilename(filename)) return null
        }
        if (actual > ProxyContract.MAX_WALLPAPER_BYTES) return null
        target = declaredTarget
      }
    }

    val queuedAt = obj.optLong("queuedAt", 0L)
    val deliveredAt = obj.optLong("deliveredAt", 0L)

    return OutboxItem(
      id = id,
      kind = kind,
      filename = when {
        kind == OutboxKind.BOOK -> filename
        kind == OutboxKind.WALLPAPER && target == ProxyContract.WALLPAPER_TARGET_SET -> filename
        else -> null
      },
      target = target,
      bytes = actual,
      body = body,
      queuedAt = queuedAt,
      delivered = deliveredAt > 0L
    )
  }

  /**
   * `opt(name) as? String` rather than `optString`: Android's `optString` renders the JSON null
   * sentinel as the four character string "null", so `{"id": null}` would arrive here as a
   * perfectly legal looking id.
   */
  private fun stringField(obj: JSONObject, name: String): String? =
    (obj.opt(name) as? String)?.trim()?.takeIf { it.isNotEmpty() }

  /**
   * Resolves a manifest `bodyPath` to a real file inside the app's own storage, or null.
   *
   * Accepts both a plain POSIX path and the `file://` URI shape expo-file-system hands out, and
   * percent decodes the URI form (a copied book can carry an escaped space). Percent decoding is
   * safe HERE, unlike in the request path, because the result is canonicalised and then required to
   * sit under an allowed root: an encoded traversal resolves to somewhere outside and is refused.
   */
  private fun resolveWithinRoots(raw: String): File? {
    var path = raw.trim()
    if (path.isEmpty()) return null
    if (path.startsWith("file://")) {
      path = percentDecode(path.substring(7))
    } else if (path.indexOf('%') >= 0) {
      path = percentDecode(path)
    }
    if (!path.startsWith("/")) return null
    // A NUL truncates the name at the syscall boundary, so a path carrying one can name a
    // file other than the one it reads like. Spaces are fine: a copied book keeps its name.
    if (path.indexOf('\u0000') >= 0) return null

    val canonical = try {
      File(path).canonicalFile
    } catch (e: IOException) {
      return null
    } catch (e: SecurityException) {
      return null
    }

    for (root in roots) {
      val canonicalRoot = try {
        root.canonicalFile
      } catch (e: IOException) {
        continue
      } catch (e: SecurityException) {
        continue
      }
      if (canonical.path.startsWith(canonicalRoot.path + File.separator)) return canonical
    }
    return null
  }

  private fun percentDecode(value: String): String {
    if (value.indexOf('%') < 0) return value
    val out = ByteArrayOutputStream(value.length)
    var i = 0
    while (i < value.length) {
      val c = value[i]
      if (c == '%' && i + 2 < value.length) {
        val hi = Character.digit(value[i + 1], 16)
        val lo = Character.digit(value[i + 2], 16)
        if (hi >= 0 && lo >= 0) {
          out.write((hi shl 4) or lo)
          i += 3
          continue
        }
      }
      val encoded = c.toString().toByteArray(Charsets.UTF_8)
      out.write(encoded, 0, encoded.size)
      i += 1
    }
    return String(out.toByteArray(), Charsets.UTF_8)
  }

  companion object {
    /**
     * Section 2's id charset, `[A-Za-z0-9._~-]{1,64}`, with the dot only names refused. Ids are
     * never turned into a path by this module (bodies come from `bodyPath`), so this is about the
     * WIRE: an id with a space in it would forge a `books.txt` line, and one with a slash would
     * make the reader's `books/{id}` request unparseable.
     */
    fun isValidId(id: String): Boolean {
      if (id.isEmpty() || id.length > ProxyContract.BOOK_ID_MAX_LEN) return false
      if (id == "." || id == "..") return false
      for (c in id) {
        val ok = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' ||
          c == '.' || c == '_' || c == '~' || c == '-'
        if (!ok) return false
      }
      return true
    }

    /**
     * Section 2's filename rules, applied locally: printable ASCII only (one character is one
     * byte, so a C string walk and `Content-Length` cannot disagree), no CR or LF (it would forge
     * a manifest line), no path separators, no leading dot, the FAT reserved set refused, a quote
     * refused so `Content-Disposition` can be quoted unconditionally, at most 120 characters, and
     * an `.epub` tail. Rejected, never truncated: a truncated name can lose the extension.
     */
    fun isValidBookFilename(name: String): Boolean {
      if (name.isEmpty() || name.length > ProxyContract.BOOK_FILENAME_MAX_LEN) return false
      if (name.startsWith(".")) return false
      if (!name.lowercase(Locale.ROOT).endsWith(".epub")) return false
      for (c in name) {
        if (c.code < 0x20 || c.code > 0x7E) return false
        if (c == '/' || c == '\\' || c == '"' || c == '*' || c == ':' ||
          c == '<' || c == '>' || c == '?' || c == '|'
        ) {
          return false
        }
      }
      return true
    }

    /**
     * The wallpaper half of [isValidBookFilename]: the same printable ASCII, no CR or LF, no path
     * separator, no leading dot, no FAT reserved character and no quote, at most 120 characters.
     *
     * TWO DIFFERENCES, both from the line format rather than from the filesystem:
     *   - `.bmp`, not `.epub`. The firmware scans `/.sleep` for that extension, so a name without
     *     it is a file the reader writes and never looks at again.
     *   - A bare '-' is REFUSED. A `wallpaper.txt` line puts '-' in the filename position for a
     *     primary, so an entry actually named '-' would be indistinguishable from "no name" and
     *     would be applied to `/sleep.bmp` instead of the rotation.
     */
    fun isValidWallpaperFilename(name: String): Boolean {
      if (name.isEmpty() || name.length > ProxyContract.WALLPAPER_FILENAME_MAX_LEN) return false
      if (name.startsWith(".")) return false
      if (name == ProxyContract.WALLPAPER_NO_FILENAME) return false
      if (!name.lowercase(Locale.ROOT).endsWith(".bmp")) return false
      for (c in name) {
        if (c.code < 0x20 || c.code > 0x7E) return false
        if (c == '/' || c == '\\' || c == '"' || c == '*' || c == ':' ||
          c == '<' || c == '>' || c == '?' || c == '|'
        ) {
          return false
        }
      }
      return true
    }
  }
}

// -------------------------------------------------------------------------------------------
// Which contract endpoint a forwardable target names
// -------------------------------------------------------------------------------------------

internal enum class MailboxEndpoint {
  LATEST,
  FRAME,
  BOOKS_MANIFEST,
  BOOK_BODY,
  WALLPAPER_MANIFEST,
  WALLPAPER_BODY,
  OTHER
}

/**
 * [itemId] is the `{id}` segment for a BOOK_BODY or a WALLPAPER_BODY and null otherwise. One field
 * rather than two: the two endpoints never coexist in one request, and a second nullable would make
 * "which one is set" a thing every caller has to reason about.
 */
internal data class MailboxTarget(val endpoint: MailboxEndpoint, val itemId: String?)

/**
 * Classifies a forwardable path by its TAIL, never by its head.
 *
 * The head is `/m/{boxId}` today and `/mailbox/m/{boxId}` on a sub path deployment, and the module
 * is deliberately agnostic about it (`allowedPathPrefix` already pins what may be forwarded at
 * all). The tails are fixed by section 2 and are what decide whether the phone can answer from its
 * own outbox.
 *
 * The path reaching here has already been through `HttpWire.validateTargetSyntax`: no percent
 * escapes, no `.` or `..` segments, no `//` runs, and a bounded character set. So a book id lifted
 * out of it is a plain segment, and it is only ever used as a MAP KEY against the manifest, never
 * to build a filesystem path.
 */
internal object MailboxPaths {
  fun classify(path: String): MailboxTarget {
    if (path.endsWith(ProxyContract.LATEST_SUFFIX)) return MailboxTarget(MailboxEndpoint.LATEST, null)
    if (path.endsWith(ProxyContract.FRAME_SUFFIX)) return MailboxTarget(MailboxEndpoint.FRAME, null)
    if (path.endsWith(ProxyContract.BOOKS_SUFFIX)) {
      return MailboxTarget(MailboxEndpoint.BOOKS_MANIFEST, null)
    }
    // BEFORE the body markers, deliberately: `/wallpaper.txt` is the manifest, not a body whose id
    // happens to read like one. The two cannot actually collide (a path ending `/wallpaper.txt`
    // contains no `/wallpaper/`), but the ordering is what makes that independent of the id charset.
    if (path.endsWith(ProxyContract.WALLPAPER_SUFFIX)) {
      return MailboxTarget(MailboxEndpoint.WALLPAPER_MANIFEST, null)
    }
    idAfter(path, ProxyContract.BOOK_PATH_MARKER)?.let {
      return MailboxTarget(MailboxEndpoint.BOOK_BODY, it)
    }
    idAfter(path, ProxyContract.WALLPAPER_PATH_MARKER)?.let {
      return MailboxTarget(MailboxEndpoint.WALLPAPER_BODY, it)
    }
    return MailboxTarget(MailboxEndpoint.OTHER, null)
  }

  /** The single trailing segment after `marker`, or null when there is no usable id there. */
  private fun idAfter(path: String, marker: String): String? {
    val at = path.lastIndexOf(marker)
    if (at < 0) return null
    val id = path.substring(at + marker.length)
    if (id.isEmpty() || id.indexOf('/') >= 0 || !LocalOutbox.isValidId(id)) return null
    return id
  }
}

// -------------------------------------------------------------------------------------------
// Range math for locally served bodies
// -------------------------------------------------------------------------------------------

internal data class ResolvedRange(
  val start: Long,
  val end: Long,
  /** True when the answer must be a 206 with a `Content-Range`. */
  val partial: Boolean,
  /** True when the answer must be a 416 with `Content-Range: bytes` star slash size. */
  val unsatisfiable: Boolean
) {
  val length: Long
    get() = if (unsatisfiable || end < start) 0L else end - start + 1
}

/**
 * THE RESUME MECHANISM, locally. A book is fetched across several reader windows, each asking for
 * the bytes after what it already has, so a byte of arithmetic wrong here strands a download for
 * ever: the reader appends the wrong slice, its size check fails, and it restarts from zero on
 * every future window.
 *
 * This is a line for line mirror of `parseByteRange` in mailbox/src/core.js, and it must stay one,
 * because the reader cannot tell which of the two servers answered:
 *   - no header, an unknown unit, plain garbage or a multi range is IGNORED, giving the whole body
 *     with a 200. RFC 9110 permits ignoring a Range, and a 416 for a speculative header would
 *     refuse a body the client could take whole.
 *   - a WELL FORMED range that cannot be met (start past the end, last before first, any range
 *     against an empty body) is a 416 carrying the total, so the client can correct its offset
 *     instead of looping on the same bad range.
 *   - a last byte position past the end is CLAMPED, so a reader may use a fixed window size
 *     without knowing the length first.
 *
 * NOTE ON A PRE EXISTING DIVERGENCE, recorded rather than silently inherited: `HttpWire` refuses a
 * malformed `Range` with a 400 before it ever reaches this function, where section 2 would ignore
 * it. That is the forwarder's behaviour today and applies identically to forwarded and locally
 * served requests, so the two paths still agree with each other. The ignore branches below are
 * therefore defensive, not dead policy.
 */
internal object ByteRanges {
  private val SPEC = Regex("^bytes\\s*=\\s*([0-9]*)\\s*-\\s*([0-9]*)$", RegexOption.IGNORE_CASE)

  fun resolve(header: String?, size: Long): ResolvedRange {
    val whole = ResolvedRange(0L, size - 1, false, false)
    if (header == null) return whole
    val raw = header.trim()
    if (raw.isEmpty() || raw.length > ProxyContract.MAX_RANGE_HEADER_CHARS) return whole
    val match = SPEC.matchEntire(raw) ?: return whole
    val rawStart = match.groupValues[1]
    val rawEnd = match.groupValues[2]
    if (rawStart.isEmpty() && rawEnd.isEmpty()) return whole
    if (size < 0L) return whole

    if (rawStart.isEmpty()) {
      // Suffix range: the LAST n bytes.
      //
      // An UNPARSEABLE count is a 416 and not "the whole body", because that is what core.js does
      // (its `Number.isSafeInteger` guard) and the two servers must be indistinguishable. RFC 9110
      // would allow the looser reading; agreeing with the other implementation is worth more than
      // being generous to a request the reader never sends.
      val n = parseCount(rawEnd) ?: return unsatisfiable(size)
      if (n == 0L || size == 0L) return unsatisfiable(size)
      val start = if (n >= size) 0L else size - n
      return ResolvedRange(start, size - 1, true, false)
    }

    val start = parseCount(rawStart) ?: return unsatisfiable(size)
    if (size == 0L || start >= size) return unsatisfiable(size)
    if (rawEnd.isEmpty()) return ResolvedRange(start, size - 1, true, false)

    val wantEnd = parseCount(rawEnd)
    // Not parseable as a Long means "absurdly large", which is a clamp, not a refusal.
    if (wantEnd == null) return ResolvedRange(start, size - 1, true, false)
    if (wantEnd < start) return unsatisfiable(size)
    return ResolvedRange(start, minOf(wantEnd, size - 1), true, false)
  }

  private fun unsatisfiable(size: Long): ResolvedRange = ResolvedRange(0L, -1L, false, true)

  /** Digits only by the time it gets here; null means it does not fit in a Long. */
  private fun parseCount(digits: String): Long? = digits.toLongOrNull()
}
