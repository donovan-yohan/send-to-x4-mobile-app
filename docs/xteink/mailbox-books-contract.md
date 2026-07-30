# Mailbox books sync — firmware contract + reader-side plan

Hand-off TO the firmware side. The app/mailbox side of this wire contract ships in the same batch as
this doc (`mailbox/src/core.js`, `scripts/mailbox_dev_server.mjs`); the reader half is a future
firmware milestone. Notes sync is already live and hardware-proven (`src/network/MessageSync.cpp`) —
**books ride the same mailbox, the same capability URL, and the same bounded WiFi window.**

Every firmware claim below is cited `file:line` against `~/Documents/Programs/personal/crosspoint-reader`
at the time of writing. Re-check the line numbers before quoting them in a PR.

> **SERVER HALF IS NOW IMPLEMENTED AND GREEN.** §2 is no longer a proposal: it is asserted by
> `scripts/mailbox-core.test.js` (manifest byte-exactness, every `Range` case, caps, eviction, auth,
> traversal, and notes-unchanged regressions) and smoked over a real socket against
> `scripts/mailbox_dev_server.mjs`. Where the shipped behaviour departs from this doc's original
> proposal it is called out inline as **SHIPPED**; those paragraphs, and `core.js`, are the contract.
> §§3–6 (reader side) are still a plan. `mailbox/README.md` § Books is the operator-facing copy.

---

## 1. Model — why there are no acks

**One-time provisioning, then never again.** The reader is provisioned once with
`messageSyncEnabled=1` + `messageSyncUrl=<base>` (`src/CrossPointSettings.h:244-245`). After that it
must never re-enter transfer mode to receive a book. Transfer mode stays for host-only LAN work
(`src/activities/home/HomeActivity.cpp:303`, `STR_FILE_TRANSFER`).

**The reader is authoritative.** The server publishes a manifest and serves bytes. It records nothing
about what any reader has. There is no ack, no "delivered" flag, no per-device cursor. The reader
diffs the manifest against its own state and decides what to fetch. Consequences, all deliberate:

- Two readers can share one box and both converge independently.
- A reader that loses its SD card re-downloads everything. Correct, not a bug.
- A reader that is off for a month sees only the newest `MAX_BOOKS` entries. Eviction is silent by
  design — the server has no idea anyone missed anything.
- Nothing the reader does can fail the app's publish. Publish succeeds or fails on storage alone.

**Same shape as notes, one difference.** Notes are latest-wins single-slot: one id, one frame, dedup
by `messageLastShownId` (`MessageSync.cpp:157`). Books are a *set*: a manifest of up to 20 entries,
each independently present-or-absent on the reader, each resumable across windows. That set semantics
is the whole reason books need a manifest and a reader-side state file where notes need neither.

---

## 2. Wire contract

`base = {origin}/m/{boxId}`. Same base string the reader already holds. Reads are unauthenticated —
protected by the unguessable `boxId` (capability URL), exactly like `latest.txt` / `current.frame`.
Writes are `Authorization: Bearer <writeToken>`, exactly like `publish` / `status`.

Every response carries `cache-control: no-store, no-cache, must-revalidate`
(`mailbox/src/core.js`, `baseHeaders`). Load-bearing for `books.txt` for the same reason as `latest.txt`: a
cached manifest pins the reader on a stale book set.

Caps: **`MAX_BOOK_BYTES = 24 MiB` (25165824)** hard per book; `MAX_BOOKS = 20` entries per box, oldest
evicted (entry + bytes both removed); `BOOK_FILENAME_MAX_LEN = 120`. Book id charset = the note id
charset, `[A-Za-z0-9._~-]{1,64}` (`core.js`) — chosen so an id survives the firmware's `trimId()`
(`MessageSync.cpp:36-43`) and needs no escaping in a URL path segment — **plus `.` and `..` refused**,
because the id becomes a store key and a store key becomes a filesystem path on the dev server.

> **SHIPPED — the cap is 24 MiB, not the 30 MB this doc originally specified.** Workers KV caps a
> single **value** at 25 MiB (26214400 B). A 30 MB epub would have been accepted, answered `200`, and
> then failed its `kv.put` — the app reporting success for a book the reader can never see, which is
> strictly worse than a `413`. 24 MiB sits inside the ceiling with headroom for the manifest write and
> is ~5x the largest realistic epub. It is **one** constant shared by both adapters, so a book that
> works against the LAN dev server works on Workers unchanged. The window math in §3 is re-tabulated
> against it.

### `GET {base}/books.txt` — manifest (no auth)

`text/plain`, one line per book, newest first, `\n`-terminated, **empty body when the box has no
books** (not 404 — same rule as `latest.txt`, so an empty library is a normal window and not a logged
error every sleep).

```
{id} {bytes} {filename}\n
```

`id` and `bytes` never contain a space; `filename` is the rest of the line and may. Parse as
`split-at-first-space, split-at-next-space, remainder`. `filename` must never contain `\n` — that is
what keeps the manifest line-oriented, and it is the server's job to reject it, not the reader's to
recover from it. Worst-case body at the caps (`BOOK_FILENAME_MAX_LEN = 120`):
20 × (64 + 1 + 8 + 1 + 120 + 1) = **3900 B**, so §5's 8 KB read cap is still 2x the worst legal
manifest.

> **SHIPPED — filenames are forced to printable ASCII (0x20–0x7E)**, so one character is one byte and a
> C string walk cannot disagree with `Content-Length` about where the fields are. Non-ASCII and the
> FAT-reserved set (`" * : < > ? |`) become `_`; the `.epub` extension is lowercased. An **internal**
> CR/LF is a hard `400` (it would forge a line), as are path separators, a leading `.`, a missing
> `.epub`, and over 120 chars — rejected, never truncated, because a truncated name can lose the
> `.epub` tail (§4.7). A stored manifest entry is also **re-validated on read** and dropped unless its
> filename round-trips through the same sanitizer unchanged, so a corrupted KV value cannot emit a
> forged line either.

```bash
curl -s "$BASE/books.txt"
# 01JQ8ZK4T2 1874233 The Left Hand of Darkness.epub
# 01JQ8ZJ9XA 402118 Piranesi.epub
```

### `GET|HEAD {base}/books/{id}` — the bytes (no auth)

`application/epub+zip`, `Content-Length` always correct (including on `HEAD` and on a `206`), plus
`Accept-Ranges: bytes` on every success and `Content-Disposition: attachment; filename="…"`.
**Single-range support is mandatory** — this is the resume mechanism.

> **`HEAD` reports the size on BOTH adapters, and that took a measurement.** A body-less response has
> no length for a runtime to compute, so each adapter has to pass the core's `Content-Length` through
> deliberately: node via `send()`'s `{head}` gate, Workers via `toResponse`'s. Verified on workerd
> (wrangler 4.97): `new Response(null, {'content-length': '1874233'})` goes out as
> `Content-Length: 1874233`, while a 10-byte body sent with the same header goes out as
> `Content-Length: 10` — the runtime overrides a body it can measure and honours the header when it
> cannot. That asymmetry is why the gate is on `body === null && HEAD` and not on either alone.

| Request | Response |
| --- | --- |
| no `Range` | `200`, full body |
| `Range: bytes=N-` | `206` + `Content-Range: bytes N-{size-1}/{size}`, body = bytes `N..size-1` |
| `Range: bytes=N-M` | `206` + `Content-Range: bytes N-{min(M,size-1)}/{size}`, body = that slice |
| `Range: bytes=-N` | `206`, the **last** N bytes |
| well-formed but unmeetable: `N >= size`, `M < N`, any range on an empty body | `416` + `Content-Range: bytes */{size}` |
| **multi-range, unknown unit, or garbage** | **IGNORED → `200`, full body** |
| unknown id, or the manifest names it but the bytes are absent | `404` (self-healing — retry next window) |
| stored bytes disagree with the manifest's `bytes` | `500 {"error":"corrupt_book"}` — refused, never served |

> **SHIPPED — a malformed `Range` is IGNORED, not 416**, which this doc originally lumped together with
> `N >= size`. RFC 9110 explicitly permits a server to ignore a `Range` it does not support, and a
> `416` for a header the client sent speculatively would refuse a body the client could take whole. So
> the split is: **unparseable or multi-range → 200 full body**; **well-formed but unmeetable → 416**.
> Only the second class can loop, and the `416` carries the total precisely so the client can correct
> its offset instead of retrying the same bad range forever. A last-byte-pos past the end is
> **clamped**, so the reader may use a fixed window size without first knowing the length.
>
> Multi-range stays unimplemented on purpose: `multipart/byteranges` is a second body format to parse
> on an ESP32 and a resume needs exactly one range. If the reader ever sends one it gets the whole file
> — correct, just not what it asked for, so **don't**.

```bash
# probe size without body
curl -sI "$BASE/books/01JQ8ZK4T2"

# resume from byte 655360
curl -s -D- -o /dev/null -H 'Range: bytes=655360-' "$BASE/books/01JQ8ZK4T2"
# HTTP/1.1 206 Partial Content
# content-range: bytes 655360-1874232/1874233
# content-length: 1218873

# past the end
curl -s -D- -o /dev/null -H 'Range: bytes=99999999-' "$BASE/books/01JQ8ZK4T2"
# HTTP/1.1 416 Range Not Satisfiable
# content-range: bytes */1874233
```

### `POST {base}/books` — publish (bearer)

Headers `X-Book-Id` (id charset, ≤64), `X-Filename`, `Content-Type: application/octet-stream`, body =
epub bytes. `X-Filename` must sanitize to a safe `*.epub`; path separators and traversal are rejected,
not stripped. `200 {"ok":true,"id","filename","bytes"}`; `401` bad token; `400` bad id / bad filename /
**empty body**; `413` over `MAX_BOOK_BYTES`; **`503` storage failure, carrying `"published": false`** so
a retry can tell "nothing landed" from "the response was lost".

> **SHIPPED — a new book also replaces any entry with the same filename** (case-insensitively, because
> the SD card is), dropping the superseded blob. Two manifest entries naming one file would make a
> filename-based diff unresolvable, and re-sending a book under a fresh id would otherwise advertise
> the stale copy forever. This does **not** rescue filename diffing on the reader — §3 still needs the
> id-keyed state file, because `/read/` moves the file out from under `/books` — it just guarantees the
> manifest itself never names one file twice.
>
> **SHIPPED — write ordering, and it is load-bearing.** Publish writes the **blob first, the manifest
> second**: the manifest must never advertise a book whose bytes are absent, because the reader budgets
> a whole window per download and on KV the two keys replicate independently. `DELETE` is the mirror
> image — **manifest first, blob second**. Eviction/GC runs last and never fatally. A failed manifest
> write leaves the orphaned blob in place deliberately: a `put` that threw may still have landed, and
> deleting the bytes of a manifest that actually moved would turn a live book into a permanent 404.

```bash
curl -s -X POST "$BASE/books" \
  -H "Authorization: Bearer $WRITE_TOKEN" \
  -H 'X-Book-Id: 01JQ8ZK4T2' \
  -H 'X-Filename: The Left Hand of Darkness.epub' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @book.epub
# {"ok":true,"id":"01JQ8ZK4T2","filename":"The Left Hand of Darkness.epub","bytes":1874233}
```

### `DELETE {base}/books/{id}` — unpublish (bearer) → `200` / `404`

### `GET {base}/status` (bearer) — gains `books: [{id, filename, bytes}]`

Newest first, and **always present as an array** (`[]` on an empty box), so the app never has to
distinguish "no books" from "a mailbox that predates this route". Summary only — never the blobs. With
no acks anywhere, this is the only place the app can see what the box holds.

Notes keys are untouched; books live under additive keys only
(`box:{id}:books:index`, `box:{id}:book:{bookId}`). The blob key is content-addressed by book id for
the same reason the frame key is: the bytes served are selected *by* the id inside one request, so a
replica holding the manifest but not yet the blob can only 404 — never hand out another book's bytes
under this name. (`book:` vs `books:` keeps the dev server's `:`→`_` key-to-filename mapping injective.)

**What the contract does NOT give you:** no content hash. `bytes` is the only integrity signal the
server offers, so the reader's promote gate is a size match and nothing stronger (§4). If a hash
column is ever wanted, add it as a 4th field — the parse above ignores trailing fields only if you
write it to, so decide now whether `filename` is "rest of line" (it is, today) or field 3 of 4.

> **SHIPPED — and therefore: a book id is meant to be IMMUTABLE.** Re-POSTing the same id is supported
> (that is what a retry does) and overwrites the blob. There is no ETag and no `Last-Modified`, so
> `If-Range` is not honoured, and the **only** signal available to a reader mid-resume is the total in
> `Content-Range` versus the `bytes` it read from `books.txt`. A same-size replacement is undetectable.
> The app should mint a new id for different content; the reader must compare those two numbers on
> every window and restart the download when they disagree (§3 step 6).

---

## 3. Reader-side sync algorithm

### Placement

Books sync runs **after** note sync inside the same window, so the note (tiny, latency-sensitive,
already proven) is never delayed by a book. Seam: `src/main.cpp:224`, immediately after
`MessageSync::syncBeforeSleep(display.getBufferSize())`, before the WiFi teardown at
`main.cpp:226-231`. The sleep screen is already painted at that point (`main.cpp:217-223`), which is
what makes the window invisible.

Reuse `connectHeadless()` (`MessageSync.cpp:66-112`) — do not open a second connect path. Ideally
books sync is a function the note sync calls while the link is already up, so the ≤6 s connect budget
(`MessageSync.cpp:32`) is paid once.

### Algorithm

```
1. (link already up from note sync)
2. GET base + "/books.txt"          -> manifest lines, hard-capped (see gap G5)
3. load /books/.mailbox-books-state -> set of ids already done or dismissed
4. want = manifest ids - state ids  -> take the FIRST one only (newest first)
5. part = "/books/.incoming/" + id
   have = Storage.exists(part) ? size(part) : 0
   if (have > manifest.bytes) { Storage.remove(part); have = 0; }   // server replaced it
   if (have == manifest.bytes) goto 8                               // already complete
6. GET base + "/books/" + id with "Range: bytes=<have>-", appending to `part`,
   until the per-window byte/time budget is spent or the body ends.
   - 206 -> append Content-Length bytes; CHECK the total in Content-Range against
     manifest.bytes and discard `part` + restart if they differ (the only signal
     that the book changed underneath the resume — see §2, immutable ids).
   - 416 -> the offset is past the end. Take the total from "bytes */{size}" and
     correct; never retry the same range.
   - 200 when a Range WAS sent -> the server ignored the header (malformed): take
     the whole body or fall back to a non-resuming download.
7. if (size(part) != manifest.bytes) return;   // more windows needed, keep `part`
8. promote: remove dest if present, rename part -> "/books/" + sanitized filename,
   append "{id} done" to the state file.
9. WiFi off (MessageSync.cpp:168 already does this on the note path).
```

**One book per window.** Not a limitation — it keeps the window bounded, keeps the state machine
single-slot, and newest-first means the thing the user just sent is the thing that arrives first.

### Why filename-presence diffing does not work

Tempting: skip the state file, diff on `Storage.exists("/books/" + filename)`. **This is broken by an
existing firmware feature.** When a book is finished, `EpubReaderActivity` moves it out of its folder
into `/read/` (`src/activities/reader/EpubReaderActivity.cpp:60` `READ_FOLDER = "/read"`,
`:122-131` `moveFinishedBookToReadFolder`, called from `:234-240`) — and `buildReadFolderDestination`
(`:99-120`) appends ` (2)`, ` (3)`… on a name collision, so **the file both leaves `/books` and can
change name.** Filename
diffing would re-download every book the user finishes, forever, silently. A user-initiated delete has
the same effect.

So `/books/.mailbox-books-state` is **required**, keyed by id, never by filename:

- One line per id: `{id} done` or `{id} skip` (skip = user deleted it, don't fetch again).
- Dot-prefixed → hidden from the file browser (`FileBrowserActivity.cpp:41`, gated on
  `SETTINGS.showHiddenFiles`).
- Rewrite the whole file on change; at a 64-id ring it stays under ~4.5 KB.
- Keep a **ring larger than `MAX_BOOKS`** (64 suggested). Pruning entries the moment they drop off the
  manifest means an evict-then-republish under the same id re-downloads. 64 ids costs nothing.

### Byte budgets — the actual math

Throughput. The one measured firmware number in the tree:
`freeink-sdk/libs/network/SecureNet/include/SecureHttpClient.h:550-555` — "at 512 B a consuming
firmware measured **~30 KB/s** and slow CDNs dropped the connection mid-stream; 2 KB removed the
stall", and `READ_CHUNK` is now 2048. So **30 KB/s (0.24 Mbps) is a measured pessimistic floor**, and
the 0.5–1.5 Mbps design band = **60–190 KB/s**. Everything below is computed at all three; treat the
band as unmeasured until the foreground path (§3, option C) reports real numbers off hardware.

Fixed cost per window, before the first payload byte: connect ≤6 s (`MessageSync.cpp:32`) + a full
TLS handshake, because `HttpDownloader` constructs a fresh `SecureHttpClient` per call
(`HttpDownloader.cpp:54`) and its keep-alive (`SecureHttpClient.h:107`) therefore never survives
across calls. **Call it 8 s worst case** (gap G6 removes most of it).

Transfer budget `B` per window, and windows needed for a **2 MB (2,097,152 B)** epub:

| `B` | payload s @30 KB/s | windows @30 | @60 | @190 | window efficiency (B/(B+8s)) |
| --- | --- | --- | --- | --- | --- |
| 10 s | 68.3 s | 7 | 4 | 2 | 56% |
| **20 s** | 68.3 s | **4** | **2** | **1** | **71%** |
| 30 s | 68.3 s | 3 | 2 | 1 | 79% |

**Recommend `B = 20 s`** → a 28 s worst-case sleep-entry stall. Shorter windows lose to the fixed
cost; longer ones buy little and raise the "user picks the device back up mid-window" risk.

Typical epub sizes against `B = 20 s`, at the pessimistic floor. **Every row divides by 30720 B/s**
(30 KiB/s) and every size is binary — stating the divisor once because the 24 MiB row was previously
computed at 30000 B/s, which is the same number in the wrong unit and put that row 2.4% out:

| size | payload s (`bytes / 30720`) | windows (`⌈s / 20⌉`) |
| --- | --- | --- |
| 400 KiB (text-only novel) | 13.3 s | **1** |
| 1 MiB (novel + cover art) | 34.1 s | 2 |
| 2 MiB | 68.3 s | 4 |
| 4 MiB | 136.5 s | 7 |
| 24 MiB (`MAX_BOOK_BYTES`, 25165824 B) | 819.2 s | 41 |

**The headline: the common case is one window even at the measured floor.** At ~4 sleeps/day a 2 MiB
book lands within a day worst-case, a 4 MiB book in ~2 days. The 24 MiB cap is a safety rail against a
runaway upload (and the KV value ceiling), not a supported target — at 41 windows it is ~10 days of
sleeps. The app should warn above ~4 MiB and steer big books to the foreground path.

Power: order **~1 mAh per 28 s window** at ESP32-C3 RX currents, so single-digit mAh/day at 4
sleeps. **This is an estimate, not a measurement** — measure it before shipping the unconditional
sleep-entry variant, because it is the only argument against option A below.

RAM: the reader has ~50 KB free heap against a ~51 KB framebuffer
(`docs/xteink/milestone-2-backlog.md:3` in the firmware repo). Books sync must therefore stream to SD
and never buffer a book — which the existing `downloadToFile` sink already does
(`HttpDownloader.cpp:275-278`) — and must not buffer the manifest unboundedly either (gap G5).

### When to run — pick honestly

**A. Sleep-entry, unconditional, right after note sync.** Pure north star: zero UI, books just appear.
Costs every sleep up to `B + 8 s` where today it costs ~8 s. Risk: a POWER press during a 28 s window
— the panel already shows the sleep screen so the device *looks* asleep, and the current code already
accepts that tradeoff for notes (`main.cpp:217-223`), but 28 s is not 8 s. Battery unmeasured.

**B. Sleep-entry, gated on charging.** Kills the battery and latency arguments outright. But a reader
that is not charged overnight **never syncs, silently** — "the book never arrived" is a strictly worse
failure than "the book arrived tomorrow", and it is undebuggable from the app side because there are
no acks (§1). Do not make this the default gate. Ship it as a setting, default off.

**C. Foreground "Sync library" in the transfer screen** (near `HomeActivity.cpp:303`
`STR_FILE_TRANSFER`). No window budget at all: run to completion or until cancelled —
`downloadToFile` already takes a `cancelFlag` (`HttpDownloader.h:45`, honoured at
`HttpDownloader.cpp:78-81` / `:190-193`). Progress is visible, failures are visible, throughput gets
measured for free. Not the north star: it is a manual step.

**Recommendation: C first, then A, with B as a setting.** C de-risks every genuinely new piece — Range
plumbing, resume-append, staging, manifest parse, promote gate — behind a screen where a failure is
visible and cancellable, and it is the honest place for it because it *replaces* the transfer-mode
dance rather than sitting beside it. Then turn on A with `B = 20 s` in the same release cycle, using
C's real throughput numbers instead of the 30 KB/s guess. Do not gate on charging by default.

---

## 3A. Note delivery — the lock-screen model (recommended firmware milestone)

> **Amended in round 2 — see *Reversion rule* below.** The name "lock-screen model" is kept because
> everything else in this section (and every cross-reference to it elsewhere in this doc, plus the
> firmware branch `m2-2-lock-screen-sync`) still holds: a note never renders live, it arrives as the
> sleep image, ahead of every wallpaper mode. What changed is how long it stays: a note now gets
> **one** sleep and the configured wallpaper comes back, instead of holding the panel until a newer
> note replaced it. Round-2 amendments are marked inline.

Books are a set that lands in a library; a **note** is a single latest-wins frame, and the shipped
sleep-entry sync (`MessageSync::syncBeforeSleep`, `MessageSync.cpp:131-199`) already fetches it inside
the same window §3 hangs books off. This section is the note half of that window, and it is here rather
than in its own doc because it competes for exactly the same 8 s fixed cost, the same
`connectHeadless()` link (`MessageSync.cpp:66-112`), and the same `~50 KB` heap.

### The model — user-decided, definitive

**A new mailbox note IS the sleep screen, for exactly one sleep. A note never renders live and never
interrupts.**

That is the whole delivery mechanism. There is no banner, no toast, no press-to-view, no "you have a
new note" state to dismiss. The user sets the book down, the panel paints, and the note is what is on
the panel. Picking the device back up is a normal wake into whatever they were reading. Set it down
again and the configured wallpaper is back — see *Reversion rule* below.

`MessageDisplayActivity` (`src/activities/util/MessageDisplayActivity.cpp:12-49`) is **no longer the
delivery path.** It may stay as an *optional viewer* — a menu entry that re-opens the current note
full-screen, since it already blits the staged frame straight into the live framebuffer with no second
allocation (`:15-32`) and `Back` dismisses it (`:45-49`). If it is kept, drop the
`markCurrentNoteShown()` call at `:42`: under this model "shown" is not a thing (see *What this
retires* below).

Two arrival paths, both terminating in the same place:

| | note published while the reader is | delivered | worst-case latency |
| --- | --- | --- | --- |
| **A** | **awake** | existing sleep-entry sync stages it, and the same sleep-entry paints it as the sleep screen | immediate — it is on the panel when the user sets the book down |
| **B** | **asleep** | next wake runs a silent background fetch; the note takes the panel at the **next** sleep-entry | one wake→sleep cycle |

Path B's one-cycle lag is **deliberately accepted** — it is the price of "zero interruption", and it is
the honest trade against the alternative (waking the panel at the user, which the product has already
rejected).

#### Reversion rule — display-once, then the wallpaper comes back

**AMENDED (round 2, user-decided, definitive). The previous rule was "the latest note stays the lock
until a newer note replaces it — no revert-to-wallpaper". It is now:**

> **A note gets exactly one turn on the panel.** The first sleep-entry after a note is staged paints it
> as the sleep image. Every subsequent sleep — and every boot — paints the **normal configured
> wallpaper** (`SETTINGS.sleepScreen`: `CUSTOM` `/sleep.bmp` or `/.sleep/*`, `DARK`, `COVER`, …) until a
> newer note arrives. There is still no timer and no read-tracking; the turn is consumed by the
> **paint**, not by the user.

Still true, and unchanged: a note never renders live, the note branch sits ahead of *every* wallpaper
mode, and quick-resume sleeps are exempt.

Three properties of "one turn" that are load-bearing:

- **Keyed on the note id, not on a boolean.** The turn is spent when
  `APP_STATE.messageLastDisplayedId` (`src/CrossPointState.h:39`) equals the staged `current.id`. A
  newer note has a different id, so it gets its own turn with no flag to clear.
- **Written at the moment of the paint** (`MessageSync::markStagedNoteDisplayed()`,
  `src/network/MessageSync.cpp:481-493`), immediately after `displayBuffer()` returns — never at
  staging time. A note that was staged but never reached the panel (the sync died after the promote, or
  that sleep was a quick-resume) keeps its unspent turn and takes the next normal sleep.
- **The frame stays staged.** Only the *automatic sleep-image precedence* is consumed.
  `/.love-notes/current.frame` is not deleted, so an optional on-demand viewer can be re-introduced
  without changing delivery. `MessageDisplayActivity` is that viewer and it is **not wired up today** —
  `ActivityManager::goToMessage()` (`src/activities/ActivityManager.cpp:237`) has no callers anywhere in
  the tree — so re-introducing it is a menu entry, nothing more. It deliberately does **not** mark the
  note displayed (`src/activities/util/MessageDisplayActivity.cpp:7-22`).

**There is no exception for an id-less frame.** A staged frame with **no id sidecar** is treated as
*unseen* — it gets a turn — and `markStagedNoteDisplayed()` **mints a local key** (`local-{millis}`)
into `/.love-notes/current.id` at the moment of the paint, so its turn is consumed like any other. Two
facts make that safe:

- Every writer clears `current.id` **before** it stages a frame — the app's direct send deletes both
  slots as step 1 of *every* send (`src/services/love_note_sender.ts`, "BOTH SLOTS ARE CLEARED FIRST"),
  and the mailbox route drops the sidecar rather than leave a stale one (below). So an empty sidecar
  means "not keyed yet", never "already painted", and a genuinely new id-less frame earns a fresh turn.
- Download dedup is unaffected: a mailbox `latestId` can never equal a `local-…` marker, so the frame
  stays exactly as re-fetchable as it was with no sidecar at all.

This matters because an id-less frame is **not** only the app's `stageId:false` diagnostic. A normal
direct send uploads the 52 KB frame and *then* the sidecar, and a sidecar upload that fails after a
successful frame is a documented, non-fatal outcome (`SendLoveNoteFrameResult.idStaged:false` /
`idError`, surfaced in `history_view.ts` and `message_history.ts`). Exempting id-less frames would let
one flaky WS link pin a note to the panel forever with no way for the user to clear it. *(The app's own
`idError` copy still says "the reader will re-show this note on every wake" — that string, and the
round-1 `messageLastShownId` references around it, are stale as of this amendment.)*

**A partial promote never suppresses a note.** `promoteIncoming()` checks the `current.id` write and, if
it fails after a successful rename, **deletes** `current.id` (`MessageSync.cpp`). Leaving the previous
note's id next to the new frame would be silently fatal under display-once: the stale id compares equal
to `messageLastDisplayedId`, so *both* paint gates skip the note while the mailbox re-downloads its
52 KB every window. Dropping the sidecar makes the frame read as id-less, i.e. unseen, so it still gets
its turn.

**Download dedup is untouched by all of this** — see *What this retires* below.

### Where it slots — the sleep-screen render path

The sleep image is chosen in exactly one place: `SleepActivity::onEnter()`
(`src/activities/boot_sleep/SleepActivity.cpp:20-57`). After the quick-resume shortcut (`:23-30`) it
switches on `SETTINGS.sleepScreen` (`:41-56`) across the `SLEEP_SCREEN_MODE` enum
(`src/CrossPointSettings.h:15-24`, default `DARK` at `:175`):

| mode | handler | source |
| --- | --- | --- |
| `BLANK` | `renderBlankSleepScreen` (`:345-348`) | clear + HALF |
| `CUSTOM` | `renderCustomSleepScreen` (`:59-151`) | `/sleep.bmp` (`:68`), else a random BMP from `/.sleep` or `/sleep` (`:62`, `:80-87`, `:120-146`), else default (`:150`) |
| `COVER` | `renderCoverSleepScreen` (`:254-331`) | book cover BMP, falls back to default |
| `COVER_CUSTOM` | cover from reader, custom otherwise (`:48-53`) | |
| `QUICK_RESUME` | `renderLastScreenSleepScreen` (`:333-343`) | last screen + moon icon |
| `DARK` / `LIGHT` / default | `renderDefaultSleepScreen` (`:157-172`) | logo + "Sleeping", inverted unless `LIGHT` (`:167-169`) |

**"Prefer the staged note over the wallpaper" is a single new branch at the top of the switch**
(`SleepActivity.cpp:49`), ahead of every mode: if `/.love-notes/current.frame` exists and its size
equals `renderer.getBufferSize()`, blit it and paint. Do **not** put the branch inside
`renderCustomSleepScreen` — a note must take the screen for a user on `DARK` or `COVER` too.

**Round 2 — the branch is gated, and it records the paint.** `renderNoteSleepScreen()`
(`SleepActivity.cpp:88-95`) is now three statements in a fixed order:

```
if (!MessageSync::noteAwaitingDisplay()) return false;   // is it this note's turn?
if (!MessageSync::loadStagedNote(fb, size)) return false; // 48-52 KB read, only when it is
renderer.displayBuffer(HalDisplay::HALF_REFRESH);
MessageSync::markStagedNoteDisplayed();                   // AFTER the panel took it
```

`noteAwaitingDisplay()` (`src/network/MessageSync.cpp:470-479`) is asked **first** so an
already-displayed note costs one ~128 B sidecar read per sleep instead of a full frame read, and the
`false` return drops straight through to the configured wallpaper mode below it.

The blit itself is already written twice in the tree, and the second one is the pattern to copy:
`loadSleepFrameBuffer()` (`src/main.cpp:181-193`) reads a raw frame file straight into
`display.getFrameBuffer()`, **rejects a short read against `display.getBufferSize()`**, and deletes the
file on mismatch. A note frame is byte-identical in shape — that is the whole point of the
`current.frame` contract — so the note branch is `loadSleepFrameBuffer()` minus the delete, plus
`renderer.displayBuffer(HalDisplay::HALF_REFRESH)`.

**Paint it HALF, not FULL.** Every sleep screen in the file paints with a single HALF refresh (`:171`,
`:233`, `:341`, `:347`) and the comment above `renderDefaultSleepScreen` (`:153-156`) says why: the OEM
X4 firmware's only clean refresh in normal operation is the single-pass `0xD7` sequence, and
`FULL_REFRESH` selects the multi-flash GC waveform (`0xF7`) that generated the blinking complaint.
`MessageDisplayActivity` uses `FULL_REFRESH` (`:40`) because it is a foreground activity; the lock
screen must not.

### Path A — note arrives while the reader is awake

**There is an ordering bug to fix first, and it is the only genuinely non-obvious part of this
milestone.** Today `enterDeepSleep()` paints the sleep screen *before* it syncs:

- `src/main.cpp:211` `activityManager.goToSleep(fromTimeout)` → `ActivityManager::goToSleep`
  (`src/activities/ActivityManager.cpp:216-219`) does `replaceActivity(SleepActivity)` **and calls
  `loop()` immediately** — its own comment: *"sleep screen must be rendered immediately, the caller
  will go to sleep right after this returns"*.
- `src/main.cpp:224` `MessageSync::syncBeforeSleep(display.getBufferSize())` runs **after** that, and
  the comment at `:217-223` states the reason: the painted sleep screen is what hides the bounded WiFi
  window from a user who walked away. §3 leans on the same fact.

So at the moment the sleep screen is chosen, the note this window is about to fetch **is not staged
yet.** Three ways out:

- **A1 — sync first, then paint.** Move `syncBeforeSleep` above `main.cpp:211`. Correct in one edit,
  but it forfeits the property §3's whole window budget rests on: the panel would hold the last reading
  frame for up to 8 s (and `B + 8 s` ≈ 28 s once books ride along), so the device looks awake-but-frozen
  instead of asleep. **Do not do this.**
- **A2 — paint, sync, then repaint only if a new note landed. RECOMMENDED.** Keep the ordering exactly
  as it is; after `main.cpp:224` returns, if the sync promoted a *new* `current.frame`, blit it and
  issue one more HALF refresh before the teardown at `:226-231`. Cost: one extra ~1.7 s HALF paint
  (`HalDisplay.h:16`), and only on the sleeps where a note actually arrived. The user walking away sees
  the wallpaper resolve into the note. `syncBeforeSleep` currently returns `void`
  (`src/network/MessageSync.h`) — give it a `bool` "staged something new" return, which the
  promote block at `MessageSync.cpp:190-198` already knows.
- **A3 — treat A as B.** Let the note become the lock at the *next* sleep-entry. Zero new code beyond
  the §"Where it slots" branch, but it throws away the one path with zero latency for no benefit.

**Round 2 — A2 is the second paint site, and it asks the same question.** The repaint condition is now
`stagedNewNote && !isQuickResumeSleep && MessageSync::noteAwaitingDisplay()` (`src/main.cpp:280`), with
`markStagedNoteDisplayed()` immediately after the refresh (`:284`). `stagedNewNote` alone would be
*very nearly* right — the note this sync just promoted is new by construction — but routing both paint
sites through the same id check is what makes "one turn" a property of the note id rather than of two
call sites happening to agree.

**Interaction with `QUICK_RESUME`.** `isQuickResumeSleep` (`main.cpp:219-222`) short-circuits to
`saveSleepFrameBuffer()` and `SleepActivity` returns at `:29-31` before the mode switch is ever reached.
A quick-resume sleep is by definition "put the screen back exactly as it was", so **a note must not
override it** — the note keeps its **unspent** turn and takes the next non-quick-resume sleep. This is
exactly why the id is written at paint time and not at staging time; the alternative silently breaks the
quick-resume contract.

**Interaction with boot.** Boot paints no sleep/lock image at all: the two boot presentations are the
splash (`BootActivity`) and the quick-resume restore of `/.crosspoint/sleep_frame.bin`, neither of which
consults the mailbox. So the turn is decided in exactly one place — sleep-entry — and it survives a boot
because `messageLastDisplayedId` is persisted in `state.json` and reloaded at `main.cpp:390`. A device
that boots holding a note it has already shown paints the **configured wallpaper** at its next sleep,
which is the specific case the old reversion rule got wrong.

### Path B — note arrives while the reader is asleep

**A silent, zero-UI background fetch on wake.** No pill, no spinner, no status text, nothing on the
panel. The only observable effect is that the *next* sleep-entry has a newer note to lock with.

Where: `setup()`, after the go-back-to-sleep gates (`main.cpp:343-361` — `AfterUSBPower` at `:351-355`
and a too-short power press at `:344-350` both call `startDeepSleep()` and never return) and after
recovery-mode detection (`:366-380`), so a re-sleeping wake never pays for a check and the UP+POWER
bootloop escape is never delayed.

**Gate it on landing at the launcher, not on "wake".** This is not a UX nicety, it is the RAM
constraint. The routing block at `main.cpp:447-458` resumes straight into the reader (`:458`
`goToReader`) whenever a book was open and the last sleep came from the reader; it lands on Home
(`:451` `goHome`) otherwise. Only the `goHome` branch may run a check:

> **WiFi and EPUB rendering must not be resident at once.** `docs/xteink/crosspoint-firmware-assessment.md:113`
> in this repo: the C3 has ~380 KB, a reading session leaves **~50 KB free heap**, and the framebuffer
> is ~51 KB single-buffer. The two phases are naturally **sequential** — sync writes to SD, the reader
> reads later — and that is the only reason either fits. A check running while a chapter build inflates
> is an OOM, not a slowdown.

**Cancellation is therefore mandatory, not optional.** If a check is in flight and the user opens a
book — `HomeActivity::onSelectBook` → `activityManager.goToReader` (`src/activities/home/HomeActivity.cpp:343`)
— the check must **tear WiFi down before the reader activity is constructed**, not merely stop reading.
`wifiOff()` (`MessageSync.cpp:58-61`, `WiFi.disconnect(true); WiFi.mode(WIFI_OFF)`) is the established
teardown and is already called on every exit path of `syncBeforeSleep`. Note that mode-off does not
defragment; see *Heap ordering* below.

**"Background" needs a definition, because there is only one render task.** `ActivityManager::begin`
creates exactly one (`src/activities/ActivityManager.cpp:25-39`, `"ActivityManagerRender"`, 8 KB stack)
and it renders on notification (`:46-60`) while the main task owns input and `loop()`. A blocking
`connectHeadless()` on the main task freezes input for up to `CONNECT_DEADLINE_MS` = 6 s
(`MessageSync.cpp:32`) — unacceptable at the launcher, where the user is about to press something. Two
honest options, and the firmware owner should pick with a measurement:

- **B1 — a third short-lived task** that runs connect + `latest.txt` + (maybe) the frame download, with
  the main loop polling an atomic "done/cancelled" flag and setting the cancel flag from
  `onSelectBook`. Costs another task stack against ~50 KB free heap, on top of the WiFi stack. Needs
  the stack size measured, not guessed.
- **B2 — poll a state machine from the main `loop()`**, one non-blocking step per iteration, reusing
  the `millis()`-deadline discipline `connectHeadless` already uses (`MessageSync.cpp:90-99`, `:99-107`).
  No new stack; requires refactoring `connectHeadless` into a stepped form, because its inner
  `while` + `delay(STATUS_POLL_MS)` loop (`:99-107`) is currently blocking by construction.

**B2 is the safer default** on a heap this tight. Either way the budget is the same as §3's fixed cost:
connect ≤6 s + one TLS handshake, **8 s worst case**, and it must be enforced by the caller against a
`millis()` deadline rather than by the 60 s per-socket-op timeout (§5 gap G7).

**Heap ordering after a Path B check.** Every WiFi *activity* in the tree ends with `silentRestart()`
in `onExit` precisely because `WiFi.mode(WIFI_OFF)` does not defragment the PSRAM-less heap. A Path B
check cannot do that — `silentRestart()` (`main.cpp:140-152`) reboots to Home and would trample the
user's launcher. So Path B must be **cheap enough not to need it**: one tiny `latest.txt` GET plus at
most one 48000 B frame write to SD, with no large allocation on the reader's critical path. If a
measurement shows a post-check chapter build OOMs anyway, the fallback is to **skip the download** on
Path B and only refresh the id — the note then arrives on the sleep-entry sync, i.e. Path B degrades to
"no worse than today".

**Throttling — and why a wall-clock throttle is not cleanly available.** The obvious "skip if the last
sync was < N minutes ago" has no clock to hang off. `HalClock` exposes hour+minute only
(`lib/hal/HalClock.h:29`) and only when an RTC is present (`:25`), so a stored timestamp wraps at
midnight and is absent on some units. `RTC_NOINIT_ATTR` (the `silentRebootMagic` pattern,
`main.cpp:117-118`) survives `ESP.restart()` but **not** an X4 battery sleep — see the latch note in
Appendix A2. `APP_STATE` does persist across everything, to `/.crosspoint/state.json`
(`src/CrossPointState.h:32`), and `messageLastDisplayedId` already lives there (`:39`), so an
`hour*60+minute` stamp is *possible*. **Recommendation: don't.** The natural throttle is structural —
**at most one check per wake, and only on the `goHome` branch.** A user who wakes the device ten times
in an hour to check a page is not at the launcher ten times, and the wake count is what the battery
math below is priced against.

### What this retires — state simplification

The lock-screen model deletes the entire "has this note been seen" concept, and with it the two
functions that implement it:

- **`MessageSync::hasUnreadNote()` (`MessageSync.cpp:115-120`) — no longer needed for delivery.** It
  exists to answer "should the wake hook push `MessageDisplayActivity`", and nothing pushes it any
  more. Its caller `main.cpp:330-333` (`showLoveNote` → `activityManager.goToMessage()`,
  `ActivityManager.cpp:227-231`) goes away, and with it the `showLoveNote` splash suppression threaded
  through `:423` and `:428`.
- **`MessageSync::markCurrentNoteShown()` (`MessageSync.cpp:122-129`) — no longer needed at all.** It
  writes `APP_STATE.messageLastShownId` (`CrossPointState.h:17`) + an `APP_STATE.saveToFile()`, which
  is a wake-path SD write this model simply does not incur.

**What survives is the id sidecar, with exactly one remaining job: download dedup.** `current.id`
(`MessageSync.cpp:19`) + `readStagedId()` (`:45-50`) stay, and the skip condition at `:157` loses one
of its two clauses:

```
// today
if (latestId == APP_STATE.messageLastShownId || latestId == readStagedId()) -> skip download
// lock-screen model
if (latestId == readStagedId()) -> skip download        // "we already hold this note's bytes"
```

That is strictly simpler and it removes a real failure mode: `messageLastShownId` is the reason a note
the user glanced at and dismissed could never come back. A note is not consumed by being looked at, so
the only question the *download* ever asks is *do I already have these bytes* — which the staged id
answers without any persisted app state. `messageLastShownId` was removed outright; old keys in
`state.json` are ignored by `fromJson`.

#### Round 2 — one field comes back, for DISPLAY only

Display-once needs one bit of durable memory, so `CrossPointState` gains
**`messageLastDisplayedId`** (`src/CrossPointState.h:39`, serialised at `src/CrossPointState.cpp:29`
and `:57`). It is deliberately **not** a rename of the field that was deleted, and the distinction is
the whole point:

| | `messageLastShownId` (deleted, round 1) | `messageLastDisplayedId` (added, round 2) |
| --- | --- | --- |
| gated | **downloading** — a clause in the skip condition | **displaying** — the sleep-image precedence |
| written | when the note was *viewed* | when the note is *painted as the sleep image* |
| failure mode if lost | a note is re-downloaded — harmless | a note gets a second turn on the panel — harmless |
| failure mode if wrong | the note's bytes are suppressed **forever** | one extra wallpaper-vs-note sleep |

**These two must never be re-coupled.** Download dedup stays exactly as round 1 left it — one clause,
`latestId == MessageSync::stagedNoteId()`, "do I already hold these bytes"
(`src/network/MessageSync.cpp:98`, with the reasoning in the comment above it). Feeding
`messageLastDisplayedId` back into that check would resurrect the round-1 defect *and* add a new one:
losing `state.json` would then re-download every note ever staged.

Note the asymmetry in the table's last two rows — that is why display-once is safe to persist and
delivery-gating was not.

### Staging invariants — unchanged, and load-bearing for both paths

Every note download, on **either** path, must go through the existing
`incoming → validate → promote` sequence: download to `INCOMING_FRAME` (`MessageSync.cpp:20`, `:167`),
validate `incomingSize == frameBufferSize` off SD (`:176-188`), then `remove(CURRENT_FRAME)` +
`rename` + write the id sidecar (`:190-198`), in that order. Two reasons this is not boilerplate here:

1. **A mid-download book-open must not be able to tear a frame.** Path B is cancellable by
   construction (see above), and cancellation can land at any byte. Because the bytes only ever go to
   `INCOMING_FRAME`, a cancelled Path B check leaves `current.frame` — the thing the next sleep-entry is
   going to blit — bit-for-bit intact. Writing into `current.frame` directly would let a cancelled check
   paint half a note as the lock screen.
2. **The size gate is the only integrity signal**, exactly as for books (§2, no hash). A frame is
   48000 B on the X4 800×480 panel and 52272 B on the X3 792×528 panel
   (`freeink-sdk/libs/display/FreeInkDisplay/include/FreeInkDisplay.h:47-52`, `lib/hal/HalDisplay.h:29-32`),
   so the check is device-correct only when it reads the live `display.getBufferSize()` — which is what
   `syncBeforeSleep`'s parameter already is (`main.cpp:224`).

The id sidecar write must stay **after** the rename succeeds (`MessageSync.cpp:192-197`), for the same
reason §4.5 gives for books: an id recorded for a frame that isn't there marks the note fetched and it
is never retried.

### Battery math

One constant, stated once: **~130 mA average while the WiFi modem is up**, which is what §3's
"order ~1 mAh per 28 s window at ESP32-C3 RX currents" already implies (1 mAh / 28 s = 129 mA). It is an
estimate, not a measurement — the same caveat §3 carries, and the same reason to measure before
shipping.

Per-event cost:

| event | active time | cost |
| --- | --- | --- |
| check, nothing new (connect ≤6 s + TLS + one `latest.txt` GET) | 8 s worst case | **0.29 mAh** |
| check + frame download (48000 B @ 30 KB/s floor = 1.6 s) | 9.6 s | **0.35 mAh** |
| extra HALF repaint for Path A2 | ~1.7 s panel, no radio | negligible vs the radio |

Daily budget at **4 wake→sleep cycles/day** (§3's assumption):

| configuration | checks/day | mAh/day |
| --- | --- | --- |
| today (Path A sleep-entry sync only — **already shipped**) | 4 | 1.2 |
| **+ Path B wake-side check (recommended v1)** | 8 | **2.3** |
| + optional RTC timer wake every 6 h (Appendix A2) | 12 | 3.6 |
| + optional RTC timer wake every 4 h | 14 | 4.2 |
| + optional RTC timer wake every 1 h | 32 | 9.6 |

**Path B roughly doubles the notes-sync energy and the absolute number stays under ~2.5 mAh/day.**
Against a cell in the 1500 mAh class (an assumption — no capacity figure exists anywhere in either
repo) that is ~0.15 %/day, i.e. below the noise floor of the sleep-screen refreshes themselves. Hourly
timer wakes are the first configuration where the number stops being free (~0.6 %/day), which is the
argument for 4–6 h if the timer path is ever built.

Note what is *not* in this table: books. A `B = 20 s` books window is 0.72 mAh on its own, 2.5x a note
check, and §3 already flags it as the thing to measure. The notes paths are cheap; the books path is
the one with a battery question.

---

### Appendix A1 (OPTIONAL — not required for v1): wake-side status pill and press-to-view

Superseded by the lock-screen model above and recorded because it was specified, costed, and is the
obvious thing a future owner will re-propose. **The product decision is that a note never interrupts,
so none of this ships in v1.**

The idea: after the normal wake render, if at the launcher, show a small partial-refresh
"checking for notes…" pill; on a new id, download + stage and then either show a "new note" banner with
press-to-view (`ActivityManager::goToMessage`, `ActivityManager.cpp:227-231`) or auto-render it; on
nothing-or-timeout, clear the pill silently.

**The blocking finding: there is no partial-refresh path exposed to activities today.** The primitive
exists in the SDK — `FreeInkDisplay::displayWindow(x, y, w, h)`
(`freeink-sdk/libs/display/FreeInkDisplay/include/FreeInkDisplay.h:217`, implemented at
`freeink-sdk/libs/display/FreeInkDisplay/src/FreeInkDisplay.cpp:672-688`, panel driver at
`freeink-sdk/libs/display/FreeInkDisplay/src/driver/Ssd1677Driver.cpp:424`) — but **`HalDisplay` does not wrap it and `GfxRenderer` has it
commented out**: `// void displayWindow(int x, int y, int width, int height) const;`, marked
`EXPERIMENTAL`, at `lib/GfxRenderer/GfxRenderer.h:179-180`. Activities can only paint whole frames
(`HomeActivity.cpp:332` `renderer.displayBuffer()`).

What *is* already built is the coordinate half: `screenRectToAlignedMemRect`
(`lib/GfxRenderer/GfxRenderer.cpp:266`) snaps a screen rect to the 8-pixel x-alignment
`displayWindow` requires (`:246-249`), and `readFramebufferRegion` / `writeFramebufferRegion`
(`:1560-1590`) already save and restore a rectangular region of the framebuffer — exactly the
save-under/draw-pill/restore dance a status region needs. So wiring a pill is "expose `displayWindow`
through `HalDisplay` + `GfxRenderer` and paint it `FAST_REFRESH`", not "invent partial refresh". It is
still a new public display API and a new e-ink waveform path on the launcher's critical render path,
which is a materially bigger review surface than the lock-screen branch.

Had it shipped, the auto-render-vs-banner choice was the flagged decision: auto-render steals the
launcher the user just woke into (and `MessageDisplayActivity::onEnter` paints `FULL_REFRESH`,
`MessageDisplayActivity.cpp:40` — the multi-flash waveform, at the launcher); a banner keeps control
with the user but reintroduces exactly the "unread note" state the lock-screen model deletes. The
product resolved it by removing the question.

### Appendix A2 (OPTIONAL future nicety — NOT required for v1): RTC timer wake

The appeal is real: a note published at 2 a.m. lands on a sleeping panel with no human interaction, so
even Path B's one-cycle lag disappears. **It is not required for v1, and on the X4 it may not be
possible on battery at all.**

**What would change.** Wake sources are armed in one place:
`HalPowerManager::startDeepSleep` (`lib/hal/HalPowerManager.cpp:60-92`) → `powerDownRailsForSleep()`
(`:87`) → `freeink::PowerManager::deepSleepUntilPowerButton()` (`:91`), which is
`waitForPowerButtonRelease(); armPowerButtonWakeup(); deepSleep();`
(`freeink-sdk/libs/hardware/PowerManager/src/PowerManager.cpp:92-96`). `armPowerButtonWakeup` (`:36-45`)
delegates to `armWakeOnPins` (`:14-34`), which picks the SoC-correct source at compile time:
`esp_deep_sleep_enable_gpio_wakeup` on RISC-V C3 (`:29`), `esp_sleep_enable_ext1_wakeup` on Xtensa
(`:27`). Adding a timer is one `esp_sleep_enable_timer_wakeup(us)` before `deepSleep()` (`:84-90`);
sources are additive, so the power button keeps working. **`esp_sleep_enable_timer_wakeup` appears
nowhere in the tree today** — this is new surface in the SDK's PowerManager, not a config flag.

**Then the wake-cause routing has to grow a case, and today it silently does the wrong thing.**
`HalGPIO::getWakeupReason()` (`lib/hal/HalGPIO.cpp:368-388`) maps only `ESP_SLEEP_WAKEUP_GPIO` /
`ESP_SLEEP_WAKEUP_EXT1` to `PowerButton` (`:374-377`) and falls through to `WakeupReason::Other` at
`:387`. `ESP_SLEEP_WAKEUP_TIMER` is therefore `Other`, and `Other` **falls through and boots normally**
(`main.cpp:356-360`) — lighting the panel at 2 a.m., which is the exact failure this feature is meant
to avoid. So: add `WakeupReason::Timer` to the enum (`lib/hal/HalGPIO.h:96`), and in the switch at
`main.cpp:343-361` handle it like `AfterUSBPower` (`:351-355`) — run `syncBeforeSleep`, then
`startDeepSleep()` and never return. Critically this must happen **before**
`setupDisplayAndFonts(...)` at `main.cpp:394`, so the display is never initialised and the panel keeps
holding its existing sleep frame. The note it stages becomes the lock at the next real sleep-entry,
exactly like Path B.

> **THE BLOCKER, and it is hardware: on the X4, a battery deep sleep is a power-off.**
> `startDeepSleep` pulls **GPIO13 low and latches it** on non-X3 xteink devices
> (`lib/hal/HalPowerManager.cpp:69-78`), and the comment is explicit: *"X4 GPIO13 is connected to the
> battery latch MOSFET. Keeping it low powers the MCU off on battery, while the SDK wake source still
> handles USB power."* An RTC timer cannot wake an MCU that is not powered. So timer wake on the X4
> would only fire **on USB power** — which makes it a charging-only feature, i.e. option B from §3's
> "When to run" with all of B's objections ("a reader that is not charged overnight never syncs,
> silently"). Getting it to work on battery means not latching GPIO13, which trades the near-zero
> off-state current for real deep-sleep current, on a device whose entire power story is that "off" is
> off. **Measure the latch-free sleep current before promising this feature exists.**
>
> The same latch is why `RTC_NOINIT_ATTR` is not a cross-sleep store on the X4: `main.cpp:116`
> already scopes it as "survives `ESP.restart()` but not power loss", and a battery sleep *is* power
> loss. Anything that must survive a sleep goes in `APP_STATE` on SD
> (`src/CrossPointState.h:25`, `/.crosspoint/state.json`).

Battery cost is in the table above: ~0.32 mAh per timer wake (0.29 mAh of radio plus ~2 s of boot —
deep-sleep wake is a full chip reset, so SD + settings + state load are paid again, though no display
init if the re-sleep happens before `main.cpp:394`). 6 h → +1.3 mAh/day; 1 h → +7.7 mAh/day.

### Appendix A3 (M3 companion design, future milestone): offline delivery — the phone as a mailbox proxy over an AP peer link

> **Cites in A3 and A4 are against the firmware branch `m2-2-lock-screen-sync` at `a2696cf0`** — the
> branch that shipped the §3A lock-screen refactor (`MessageSync`), the Path B wake check, and
> `BookSync`. **Branch state, may shift**: these are live lines on an actively edited branch, so
> re-derive them before quoting in a PR. Everything §3A and §3 describe as "a plan" is code on this
> branch; A3 and A4 are the parts that are not.

> **Read A4 first.** A4 builds the poll loop, the progress screen, the session cap and the teardown
> against the internet. **A3 is that same loop with a different transport underneath it** — the phone
> becomes the mailbox's front door instead of a hotspot. A3 is written as a delta on A4 and the
> numbering is historical, not an order of implementation.

#### Motivation — the mailbox needs the reader to have internet, and sometimes it doesn't

Every path in this doc terminates at `{base}`: the note probe (`MessageSync.cpp:130`
`fetchUrl(base + SUFFIX_ID)`), the frame (`:157`), the manifest and the book bytes
(`BookSync.cpp:32-33`). **All of it assumes the reader can reach the internet.** On a trip with no
hotspot the phone still has cellular and the reader has no route at all, so the mailbox is dark in
exactly the situation where a book or a note matters most.

The only offline path today is manual transfer mode: Home menu → `STR_FILE_TRANSFER`
(`src/activities/home/HomeActivity.cpp:303`) → `ActivityManager::goToFileTransfer`
(`src/activities/ActivityManager.cpp:198-200`) → *Create Hotspot*
(`NetworkMode::CREATE_HOTSPOT`, `src/activities/network/NetworkModeSelectionActivity.h:8`) → the
user joins `CrossPoint-Reader` by hand and holds the reader awake for the whole upload. Four
deliberate steps and a device that must not be put down — the exact inverse of the model §3A ships,
where the note is simply on the panel when you set the book down.

**The UX the user actually asked for is "no hotspot, no passwords, no known network."** Just: reader
into a mode, phone in pocket-range, done. **A4's phone-hotspot flow is the near-term answer** and it
is real — but it needs a 2.4 GHz hotspot toggled on by hand, a saved credential, and a phone plan that
allows tethering. And Android will not let an app turn tethering on for the user (see A4's blockquote
on `startTethering` / `startLocalOnlyHotspot`), so the app can never make that flow one-tap.

**A peer link plus an app-level proxy gets the same UX without tethering at all.** The reader raises
*its own* AP, the phone joins it as a peer while keeping cellular as its default route, and the app
runs a tiny HTTP forwarder on that link. The reader then speaks **the mailbox contract** at the phone
instead of at the internet — same endpoints, same parse, same dedup, same staging. **Nothing in §2
moves.** A3 is a *transport* change and, deliberately, not even a client change: it is one new base
URL.

#### Mechanism — one protocol, two transports

Reader mode **"Sync via phone"**:

```
1. reader:  raise own AP (existing path), do NOT start the web server
2. phone:   WifiNetworkSpecifier join of CrossPoint-Reader as a PEER
            (cellular stays the default route)
3. phone:   minimal HTTP server bound to the peer interface, forwarding
            GET|HEAD /m/*  ->  the real mailbox, over a cellular-bound socket,
            streamed, Range passed through verbatim
4. reader:  the A4 poll loop, pointed at http://{peerIp}:{port} instead of
            the configured origin -- latest.txt, current.frame, books.txt,
            books/{id}, all unchanged
5. exit:    Back -> AP down -> normal return
```

**Step 1's one deviation from the shipped AP path is the important one.** `startAccessPoint()`
(`src/activities/network/CrossPointWebServerActivity.cpp:192-243`) ends by calling `startWebServer()`
(`:242` → `:245-266`). **This mode must not.** The reader is a pure *client* on its own AP here, so
nothing on it is writable from outside — no `WebServer` on 80, no `WebSocketsServer` on 81
(`src/network/CrossPointWebServer.h:77-78`), no `/upload` / `/delete` / `/rename` handlers
(`src/network/CrossPointWebServer.cpp:151`, `:157-163`), no un-authenticated WS `START` accepting a
path (`:1595-1705`). That deletes essentially the whole security objection an open AP would otherwise
carry, and it saves the server's heap besides.

**Plain HTTP on the peer link, and it is a real win.** `SecureHttpClient` parses the scheme and
supports `http` with an explicit port (`freeink-sdk/libs/network/SecureNet/include/SecureHttpClient.h:370`,
`:372`, `:380`, and TLS is entered only when `_scheme == "https"` at `:397`), so
`http://192.168.4.2:8080/m/{boxId}` needs no cert config **and pays no TLS handshake at all**. §5's G6
— a fresh handshake per call, the dominant fixed cost in every window in this doc — simply does not
apply on the peer link. TLS terminates on the phone, which has a real stack, keep-alive and a CA
store. **A 4 s poll (A4) becomes cheap for the first time.**

**Base-URL composition, precisely.** The reader stores only the base, in
`char messageSyncUrl[128]` (`src/CrossPointSettings.h:245`, 127-char ceiling per §6), and `baseUrl()`
(`MessageSync.cpp:53-57`) hands it out with trailing slashes stripped. Because the proxy forwards
`/m/*` **verbatim**, the peer base is `http://{peerIp}:{port}` + *the path portion of the configured
base* — i.e. `http://192.168.4.2:8080/m/{boxId}`. That needs one small origin/path split of the stored
string, and §6's budget is untouched (the peer origin is shorter than any real one). Do **not** add a
second settings field: §6's rule holds, one capability URL, one budget.

> **Which IP is the phone? The firmware does not configure the AP subnet, so the default applies.**
> `softAPConfig` appears **nowhere** in the tree — the only softAP call is
> `WiFi.softAP(AP_SSID, ...)` (`CrossPointWebServerActivity.cpp:201-207`) and the only address read is
> `WiFi.softAPIP()` (`:218`, `CrossPointWebServer.cpp:220`, `:401`). So the ESP32 Arduino / ESP-IDF
> defaults govern: **AP at 192.168.4.1/24, DHCP pool starting at 192.168.4.2.** The first (and usually
> only) client therefore lands on `.2` — but **do not hardcode it.** Two honest options:
>
> - **Probe a small candidate set.** `AP_MAX_CONNECTIONS = 4`
>   (`CrossPointWebServerActivity.cpp:27`), so `192.168.4.2` … `192.168.4.5` is the entire space. One
>   cheap `GET {candidate}/cp-proxy` each — a fixed, **boxId-free** health path, for the reason in the
>   security finding below — with a short absolute deadline, which `HttpDownloader::fetchUrl` already
>   takes (`src/network/HttpDownloader.h`, `deadlineMs`). The first candidate that answers correctly is
>   the proxy, and only then does the reader send a `/m/{boxId}/…` path. Four plain-HTTP probes with no
>   handshake cost almost nothing.
>   **Recommended: it is four lines and no new SDK surface.**
> - **Enumerate the associated station.** `esp_wifi_ap_get_sta_list()` + `esp_netif_get_sta_list()`
>   gives MAC→IP directly, gated on `WiFi.softAPgetStationNum()` (already used at
>   `CrossPointWebServer.cpp:102`). Exact, but **neither IDF call appears in the tree today**, so it is
>   new surface for a problem the probe already solves.
>
> Either way, wait for `WiFi.softAPgetStationNum() > 0` before probing at all, and bound that wait.

**Auth: the proxy forwards reads and must never hold the write token.** §2's split is that reads are
protected by the unguessable `boxId` (capability URL, travels in the path) and only `publish` /
`status` / `DELETE` are bearer-authenticated. **The reader never publishes** — `HttpDownloader` only
ever issues GET (§5 G7) — so the proxy is a strictly read-only forwarder: allow `GET` and `HEAD` on
`/m/*`, refuse every other method and every other path, and never attach `Authorization`. The phone
holds a write token for its own publishing (`src/services/mailbox_client.ts`), and that token must not
be reachable from the peer interface.

#### Why this is the right shape

**One protocol, everywhere.** The reader speaks mailbox at home over the internet, speaks mailbox in
the wild at the phone's proxy, and A4's live-sync loop is *the same loop pointed at a different base*.
No second wire contract, no second dedup rule, no second staging path, no second state file, no §2
amendment. Every hardening §2 and §4 already bought — the size-match promote gate, the id-keyed state
file, `Range` resume, the reject-don't-truncate filename rules — applies unchanged on the peer link
because it is the same client code.

That is the argument against the alternative that was here first: pushing files onto the reader's
filesystem directly over the WS transfer protocol. That path bypasses the reader's staging entirely
and needs its own ordering discipline, its own dedup story, and its own duplicate-book failure mode.
It survives in A3 only as a **footnote fallback** (see the end of this appendix), not as the design.

#### Firmware delta from A4 — one activity, two transports

A4 already builds the loop, the progress screen, the session cap and the teardown. A3's firmware
delta on top of it is small and almost entirely about *which base string*:

| concern | A4 (STA) | A3 (peer proxy) |
| --- | --- | --- |
| link | `connectHeadless()` (`MessageSync.cpp:76-118`) | raise AP (`CrossPointWebServerActivity.cpp:192-241`, **minus** `startWebServer()`), wait for a station |
| base | configured origin, `baseUrl()` (`MessageSync.cpp:53-57`) | `http://{peerIp}:{port}` + path of the configured base |
| transport cost | TLS handshake per call (§5 G6) | none — plain HTTP |
| poll + staging | identical | identical |
| teardown | `wifiOff()` (`:59-62`) + `silentRestart()` | `softAPdisconnect(true)` + `silentRestart()` |

**Selection rule: internet base when STA is connected, peer base when in AP mode.** One activity, two
transports, chosen once at entry. Do not build two activities.

#### Reader radio policy at the unattended sync points — the stretch variant

**The primary A3 flow is user-initiated**, A4-shaped: a mode the user enters, a progress screen, Back
to exit. The stretch is to make it *unattended* — raise the AP at the existing sync points when no
known network is reachable, so a note or a book lands with no interaction at all. That is the north
star, and it has a hard dependency the foreground flow does not: **the phone must already be holding a
pending `WifiNetworkSpecifier` request and running the proxy**, which means a foreground service (see
*Honest constraints* below). Read this subsection as the design for when that dependency is met, not
as v1.

| sync point | entry | budget | armed from |
| --- | --- | --- | --- |
| sleep-entry (Path A + books) | `MessageSync::syncBeforeSleep` (`src/network/MessageSync.cpp:302-336`, declared `MessageSync.h:57-58`) | `SLEEP_SYNC_WINDOW_MS = 8000 + BookSync::WINDOW_BUDGET_MS` = **28 s** (`src/main.cpp:184`), absolute deadline computed at `main.cpp:241` | `main.cpp:242`; books ride the `LinkUpHook` at `main.cpp:275` → `BookSync::syncOnLink` (`src/network/BookSync.h:48`, `BookSync.cpp:355`) |
| silent wake check (Path B) | `MessageSync::beginWakeCheck` (`MessageSync.cpp:338-360`) + `stepWakeCheck` (`:362-417`) | `WAKE_DEADLINE_MS = 8000` (`:222`), plus the 30-min best-effort throttle (`:231`, `wakeThrottleAllows` `:233-253`) | `main.cpp:549-551`, gated on `landedAtLauncher` (`:486`, set only at `:510`); stepped at `main.cpp:664`; cancelled by `ActivityManager::replaceActivity` (`src/activities/ActivityManager.cpp:183`) and `:263` |

Both go through the same STA connect: `connectHeadless()` (`MessageSync.cpp:76-118`) for the blocking
path, `wakeConnectStep()` (`:263-299`) for the stepped one. Both try saved networks
**last-connected-first** (`:84-91`, `:280-288`), both fail fast per candidate on
`WL_CONNECT_FAILED`/`WL_NO_SSID_AVAIL` (`:111`, `:271-274`), and both are bounded by
`CONNECT_DEADLINE_MS = 6000` (`:33`).

**The new branch, stated exactly:** STA first, unchanged. If `connectHeadless()` returns false —
either no saved credentials (`:79-82`) or saved-but-none-reachable (`:116-117`) — raise the reader's
own AP for a bounded window (**default ~45 s, setting-tunable**), poll the peer proxy if a station
appears, then tear down and proceed to sleep. **At home this branch never executes**:
`connectHeadless()` associates inside 6 s and the window is byte-for-byte what ships today.

Raising the AP is not new code, only new *call sites*. `CrossPointWebServerActivity::startAccessPoint`
(`src/activities/network/CrossPointWebServerActivity.cpp:192-243`) is the recipe: `WiFi.mode(WIFI_AP)`
(`:197`) → `WiFi.softAP(...)` (`:201-207`) with the constants at `:23-27` (`AP_SSID = "CrossPoint-Reader"`,
`AP_PASSWORD = nullptr` → **open network**, channel 1, `AP_MAX_CONNECTIONS = 4`).

**Four things the headless window must NOT copy from that path:**

1. **`startWebServer()` (`:242`, `:245-266`).** Already stated above and it is the load-bearing one:
   this mode is a client, not a server. Nothing on the reader is writable from the peer link.
2. **`silentRestart()`.** `CrossPointWebServerActivity::onExit` reboots (`:99-107`, `main.cpp:142-154`)
   because `WiFi.mode(WIFI_OFF)` does not defragment a PSRAM-less heap. A sleep-entry window cannot
   reboot — and does not need to. `silentRestart()` already refuses while `deepSleepInProgress`
   (`main.cpp:143`, set at `:222`), and deep sleep is a full chip reset anyway, which is the same
   argument the sleep-sync comment at `main.cpp:229-235` already makes. Tear down with
   `WiFi.softAPdisconnect(true)` and fall into the existing teardown at `main.cpp:280-283`.
   (A4's *foreground* mode is the opposite case: it does not sleep afterwards, so it **does** need the
   `silentRestart()`.)
3. **The captive-portal DNS server and mDNS** (`:228-237`, `DNS_PORT = 53` at `:33`). Those exist so a
   human can type a URL. A proxy discovered by probing the DHCP range needs neither, and both cost
   heap in the tightest place in the system.
4. **The wake path.** Do **not** raise an AP from Path B in v1: the launcher is interactive and the AP
   window is long. Sleep-entry only — the panel already shows the sleep screen for the whole window
   (`main.cpp:223`), which is the property §3 leans on to make a window invisible.

> **A gate that must be separated, and it is easy to miss.** Both sync points return before touching
> the radio when `SETTINGS.messageSyncEnabled` is off or `messageSyncUrl` is empty
> (`MessageSync.cpp:303-305`, `:340-343`). The URL gate is now *correct* and must stay — the peer proxy
> forwards to a real mailbox, so a reader with no configured base has nothing to ask for. But
> `messageSyncEnabled` is a **notes** switch today; the AP window needs its own setting so a user can
> run the proxy path without opting into unattended sleep-entry radio, and vice versa.

> **THE SECURITY FINDING, and it is sharper than the open AP itself.** With no web server the open AP
> exposes nothing writable — a stranger who associates gets a DHCP lease and a device that talks to
> *them*, not the reverse. **The leak is the probe.** The reader discovers its proxy by issuing
> `GET {candidate}/m/{boxId}/latest.txt`, and `boxId` **is** the read capability for the entire mailbox
> (§2: reads are unauthenticated, protected only by the unguessable path). On an open AP the first
> station to associate takes `192.168.4.2` — so a stranger's phone can be handed the capability URL for
> the user's notes and books, unprompted, at every sleep. Two fixes, and one of them is required:
>
> - **Probe a non-secret path first.** Have the proxy answer a fixed, boxId-free health path
>   (`GET /cp-proxy` → a known string) and only send `/m/{boxId}/…` to a candidate that answered it.
>   Cheap, no crypto, and it removes the unauthenticated leak. **Do this regardless.**
>   **PINNED (both sides shipped, verified compatible):** firmware (`PeerProbe.cpp:29-75`) accepts a
>   body whose first whitespace-delimited token is exactly `cp-proxy` or `cp-proxy/<version>`; the
>   app proxy (`modules/reader-link/MailboxProxyServer.kt`) answers `200 text/plain`, body
>   `cp-proxy 1\n` (11 bytes) — its first token is `cp-proxy`, which the firmware accepts. Any
>   future proxy implementation must keep the first token exactly `cp-proxy` (bare or `/versioned`).
> - **Put a PSK on the AP.** `AP_PASSWORD` is a compile-time `nullptr` on the *transfer-mode* AP
>   (`CrossPointWebServerActivity.cpp:24`) and `softAP()` already takes one (`:203`). It stops a
>   stranger occupying one of four station slots. **Required for the unattended variant**; arguably
>   optional for the foreground one, where the user is watching.
>   **SHIPPED on the mailbox-sync AP** (`MailboxSyncActivity.cpp`, `devicePsk()`), and the rules are
>   below because the app has to store the value.
>
> A health-path handshake alone still lets an on-link attacker impersonate the proxy and *serve* the
> reader a note frame or an epub. The staging gates bound the damage — a frame must match
> `display.getBufferSize()` exactly (`MessageSync.cpp:433-439`) and a book must match the manifest
> `bytes` (§4.3) — but the manifest comes from the same attacker, so "a book the user did not send"
> is reachable. That is the honest argument for the PSK, and for defaulting the unattended variant off.

#### A3 AP passphrase — per device, minted once, user-settable, never rotated behind the user's back

The reader's "Sync with app" AP (`MailboxSyncActivity`, appendix A3's transport — **not** the shipped
transfer-mode AP, which is still open) is WPA2 with a passphrase the reader owns end to end — minted by
the firmware, changeable by the owner, never negotiated with the app. The properties the app can rely on:

- **Per device, not per session.** The value is minted on the **first** AP session a device ever
  raises and reused by every session after it, so the app pairs **once**: the user enters the
  passphrase the first time and the saved credential keeps working. This is the whole point of the
  field — the first cut regenerated it on every activity entry, which silently invalidated the app's
  stored "Reader AP password" every session and forced a retype off the panel at each sync.
- **Random when the firmware picks it, anything the user likes when they do.** The value is
  **user-settable** from two surfaces, both writing the same `mailboxApPsk` key: the reader's hosted web
  settings UI (`GET`/`POST /api/settings`) and the on-device **Settings → System → "Sync with App
  passphrase"** row, which shows the current value in the clear and opens the standard keyboard. Both
  enforce the same rule — **8–63 characters, or empty** — and the firmware never silently repairs a
  value it was handed: the web `POST` answers **HTTP 400** naming the rejected key (`Rejected (invalid
  value): mailboxApPsk`) rather than truncating, and the device shows the rule in a dialog and keeps the
  old value. A user-chosen passphrase is stored and used exactly as typed; the generation rules below
  describe only what the firmware mints when nobody has chosen.
- **Random, never derived.** 10 characters drawn from a fixed 32-symbol alphabet
  (`23456789ABCDEFGHJKMNPQRSTUVWXYZ#` — no `0`/`O`, no `1`/`I`/`L`, because it is read off e-ink and
  typed into a phone), 5 uniform bits per character out of `esp_fill_random`, so **50 bits**. It is
  **not** derived from the MAC or from anything else a beacon carries: the AP's BSSID is broadcast,
  so a MAC-derived passphrase is computable by anyone in radio range — the health-path leak above,
  one layer down.
- **Minted with the radio up.** `esp_fill_random` is a true hardware RNG only while WiFi or BT is
  enabled, so the mint happens after `WiFi.mode(WIFI_AP)` inside the AP bring-up, never at boot. A
  reader whose owner only ever syncs over a saved network therefore never mints one at all.
- **Persisted in `APP_STATE`** (`CrossPointState::mailboxApPsk` → `/.crosspoint/state.json`), written at
  the mint and thereafter only when the owner changes it. An absent key means "not minted yet"; a stored
  value outside WPA2's 8–63 character bounds is treated the same way and re-minted, so a hand-edited or
  truncated `state.json` cannot produce an AP that refuses to start. A settings write that cannot reach
  the card is rolled back and reported as a refusal rather than left live in RAM — the session must not
  run on a passphrase the card has never seen.
- **Regeneration is "set it to empty".** There is no separate regenerate button and there should not be
  one: an empty stored value is out of bounds, which is already the "not minted yet" state, so clearing
  the field from either settings surface (or clearing `mailboxApPsk` in `state.json` by hand) makes the
  **next** AP session mint a fresh one — with the radio up, where the RNG is the hardware one. The mint
  never happens on the settings screen. After a clear or a change, the app's saved credential is stale
  **by design** and the user re-pairs from the panel.
- **The join panel has no editor.** It shows the passphrase, it does not change it: a value the user is
  mid-way through typing into a phone must not move under them. Editing lives in Settings.
- **Shown every session on the join panel** — SSID, passphrase, and a `WIFI:T:WPA;S:…;P:…;;` QR — now
  showing the *same* value each time. The QR is the primary path; the printed passphrase is the
  fallback for when the camera path fails.

None of this belongs in the canonical wire block below: the alphabet and the length are firmware-side
generation rules, not values the two repos must agree on byte for byte. The app stores whatever string
the user gave it and must not assume a length, a character set, or that the value it holds is still
current — a join failure on a saved credential means "re-pair from the panel", not "retry". **Nothing on
the app side changes for this feature**, and the "do not assume" rule stops being theoretical: a
passphrase the owner typed can be 8 characters of anything WPA2 accepts, so an app that validated
against the 10-character mint alphabet would reject a perfectly good reader.

#### A3 canonical wire block — the values both repos must agree on, byte for byte

Everything below is a value the **firmware** and the **app proxy** each hold a copy of, in separate
repos with no shared compile step. A mismatch does not error anywhere: the reader probes, does not
recognise the answer, falls through to "no proxy", and both halves believe they are correct. So this
block is the single authority, and `scripts/reader-link-contract.test.js` in the app repo parses it
out of this file and fails when the Kotlin (`modules/reader-link/android/…/ProxyContract.kt`) or the
TS (`src/services/reader_link.ts`) disagrees with it. Change a value HERE first.

```text
CP_PROXY_READER_AP_SSID = CrossPoint-Reader
CP_PROXY_HEALTH_PATH = /cp-proxy
CP_PROXY_HEALTH_BODY = "cp-proxy/1\n"
CP_PROXY_HEALTH_BODY_BYTES = 11
CP_PROXY_HEALTH_CONTENT_TYPE = text/plain; charset=utf-8
CP_PROXY_PORT = 8080
CP_PROXY_FORWARD_PREFIX = /m/
```

Notes that are part of the contract and not decoration:

- The **body** is 11 bytes: `cp-proxy/1` plus one `\n`. The firmware matches on the first
  non-whitespace token (`cp-proxy`, optionally `cp-proxy/<version>`), so the trailing newline is
  ignored and a later version bump cannot brick discovery — but the app answers this exact string.
- The **port** is fixed, not negotiated: the reader has no channel to be told one. It composes
  `http://{peerIp}:8080` + the path of its own stored mailbox base.
- The **health path carries no secret** (the finding above) and is answered LOCALLY — never
  forwarded upstream — so it works before any mailbox round-trip and cannot leak the `boxId`.
- The **forward prefix** is the only path family the proxy serves; a mailbox mounted under a
  sub-path makes the app pass its full base path instead, which is strictly tighter.

Session caps are deliberately NOT in this block: they are a phone-side policy the reader never sees.
The app passes ONE cap to native (`PROXY_SESSION_MAX_MS`, 15 min) so its own deadline and the
module's watchdog cannot drift; native clamps whatever it is handed to 1..30 min.

#### Phone side (app milestone M3)

**Joining as a peer, not as the default route.** `WifiNetworkSpecifier` (Android 10 / API 29+) passed
to `ConnectivityManager.requestNetwork` joins `CrossPoint-Reader` as a peer-to-peer network:
cellular stays the default route, so the rest of the app keeps working. The corollary is the part that
breaks naively-written code — **sockets must be bound to the `Network` handed to
`NetworkCallback.onAvailable`** (`Network.openConnection`, or `bindProcessToNetwork` for the duration),
or the WS connect at `src/services/crosspoint_upload.ts:51` goes out over cellular to `192.168.4.1`
and fails. The first join shows a system approval dialog; later re-joins of an approved specifier may
skip it depending on platform version — **verify on device, do not design around it.**

**Two `Network` objects in one process, and this is the hard part of the module.** The proxy's *inbound*
listener must be bound to the peer `Network`, and its *outbound* fetch to the cellular one. That rules
out `bindProcessToNetwork`, which is process-wide and would send one of the two the wrong way; use the
per-socket path instead — `Network.getSocketFactory()` / `Network.openConnection()` on each side, and
`Network.bindSocket()` for the listening socket. Getting this wrong fails in the most confusing
possible way: the reader's requests arrive, the forward silently goes out over the peer link, and
everything times out with no error anywhere.

**The forwarder itself is small and must be boring.** Bind an HTTP server on the peer interface at a
fixed port; answer the boxId-free `GET /cp-proxy` health path the reader discovers it with; accept
`GET` and `HEAD` on `/m/*` and nothing else; forward the path verbatim to the configured mailbox
origin over the cellular socket; **stream** the response body through rather than buffering it (a book
is up to `MAX_BOOK_BYTES` = 24 MiB, §2); and pass `Range` **and** the `206` / `Content-Range` / `416` /
`Content-Length` responses back **untouched**. That passthrough is not optional: the reader's resume
logic compares the total in `Content-Range` against the manifest's `bytes` on every window and restarts
the download when they disagree (§2, immutable ids; §3 step 6). A proxy that normalizes a `206` into a
`200` silently breaks resume. Reject every other method and path, and never attach `Authorization` —
see the auth note above.

**This is a new native module; the app has none today.** `android/app/src/main/java/com/example/sendtox4/`
contains only `MainActivity.kt` and `MainApplication.kt`. The prebuild path exists (`expo ~54`,
`expo run:android`, `expo-build-properties` already a dependency in `package.json`), so this is a
config-plugin + Kotlin module, not an ejection.

**Queued-delivery watcher, for the unattended variant.** A foreground service runs while sends are
queued and holds the specifier request open; the queue itself has a shipped precedent in
`src/services/screensaver_queue.ts` (AsyncStorage-backed, with local-file cleanup). **Scan throttling,
stated honestly:** since Android 9, `WifiManager.startScan()` is throttled to **4 scans per 2-minute
window** for a foreground app and **1 scan per 30 minutes** in the background (Android's "Wi-Fi
scanning overview" / scan-throttling rules; some builds let the user defeat it in developer options,
which is not something to ship against). The reader's AP window is ~45 s. **A watcher that polls
`startScan()` can therefore miss a window outright** — one look per 30 s at best, one per half hour in
the background.

So do not scan from app code at all: keep the `NetworkRequest` **outstanding** for as long as items are
queued and let the platform's own matching fire `onAvailable` when the SSID appears. That is the
mechanism to lean on, and it is **the single riskiest platform assumption in A3** — measure how quickly
a pending specifier request latches onto an AP that lives for 45 s, on a real device, before promising
the unattended variant exists.

#### Interaction with the lock-screen model (§3A)

**A proxied note is not merely indistinguishable from a mailbox-pulled one — it *is* one.** The reader
runs `probeLatest` → `downloadIncoming` → `promoteIncoming` (`MessageSync.cpp:128-190`) against the
peer base exactly as against the internet base, so the frame lands at `/.love-notes/current.frame`
through the same `incoming → validate → promote` sequence, with the same exact-size gate (`:171-178`)
and the same id sidecar written only after a successful rename (`:183-188`). Then
`SleepActivity::renderNoteSleepScreen()` (`src/activities/boot_sleep/SleepActivity.cpp:88-95`) picks
it up at `:49`, **ahead of the whole wallpaper switch** (`:51-66`), and paints HALF at `:92`. It shows
at the next sleep, under the same display-once reversion rule (its id is recorded at `:93`, so the
sleep after that is the wallpaper again), with the same quick-resume exemption (`:29-31`).

**This is the single biggest advantage of the proxy design over pushing files directly.** A raw WS
push writes `current.frame` in place — the upload protocol writes wherever the client names — so the
reader's staging gate is bypassed and the app's own ordering discipline (both slots cleared first,
frame before id, `src/services/love_note_sender.ts:71-77`) has to stand in for it, backed only by
`loadStagedNote`'s size check at render time (`MessageSync.cpp:433-439`). The proxy needs none of that
reasoning: **§3A's staging invariants hold verbatim because it is the same code path.**

**Id sidecar dedup is unchanged, and now it works in the user's favour across transports.** The skip
condition is the single clause `latestId == readStagedId()` (`MessageSync.cpp:144`). A note drained
over the peer link is recorded under its **mailbox id**, so the next window on real internet sees the
same id and skips the download. One note, one fetch, whichever transport got there first.

**Books land in `/books` through `BookSync` itself** (`BookSync.cpp:17`, promote at `:311-318` with the
` (2)`/` (3)` collision suffix), which means the id-keyed state file `/books/.mailbox-books-state`
(`BookSync.cpp:30`) **is** written on the peer path. So the duplicate-delivery hazard that dogs a raw
WS push — the same epub arriving twice under two names because a pushed file has no state entry —
simply does not exist here. The manifest is authoritative, the state file is authoritative, and
transport is irrelevant to both. Nothing in §3 or §4 changes.

#### Heap and sequencing

**The 50 KB reading constraint does not bind here, and that is worth being precise about.**
`crosspoint-firmware-assessment.md:113` in this repo: the C3 has ~380 KB, a reading session leaves
**~50 KB free heap**, the framebuffer is ~51 KB. That is why §3A gates Path B on the launcher branch
(`main.cpp:480-486`). The AP window sits at a **sleep-entry**, after
`activityManager.goToSleep(fromTimeout)` (`main.cpp:223`) has already replaced the reading activity
and painted — **no EPUB is resident and no chapter build is in flight.** The two phases are
sequential by construction, which is the same reason the note and book windows fit.

**And because this mode starts no web server, the footprint is far smaller than the transfer mode's.**
The costs that make transfer mode heavy are the ones A3 skips: a `WebServer` on 80, a
`WebSocketsServer` on 81, and the 4 KB upload buffer (`UPLOAD_BUFFER_SIZE = 4096`,
`CrossPointWebServer.h:41`). What is left is `WiFi.softAP` plus the same `HttpDownloader` +
`SecureHttpClient` the STA path already pays for — **minus** the TLS session, since the peer link is
plain HTTP (see *Mechanism*). It is plausible that AP-client mode is *cheaper* than today's STA-TLS
window. Do not assert that without a number: the free-heap instrumentation is already in the tree
(`CrossPointWebServerActivity.cpp:66`, `:92`, `:109`, `:194`, `:239`), so bracket the AP raise and read
it off a device.

One thing the mode loses by skipping `CrossPointWebServer::begin()`: that is where
`WiFi.setSleep(false)` lives (`CrossPointWebServer.cpp:120`), and the comment there calls it critical
for reliable server operation. A client-only AP mode should decide this explicitly rather than inherit
it — modem sleep on a soft AP costs latency on every poll but is the only lever on the battery number
below.

**The AP window must never delay sleep past a bounded deadline, and it must share the existing one.**
Today the whole sleep-entry is capped at 28 s by a single absolute `millis()` deadline computed at
`main.cpp:241` and enforced inside `BookSync`'s body read loop (`BookSync.h:41-46`). The rule for A3:
**one deadline, computed once, covering STA + notes + books + the AP window** — the AP window takes
what is left, never a fresh 45 s. The windows are mutually exclusive anyway: the AP only runs when the
mailbox window never happened.

Worst case with a 45 s window is **~6 s failed STA + 45 s AP ≈ 51 s** of sleep-entry stall against
today's 28 s, with the sleep screen showing throughout. §3 already names "the user picks the device
back up mid-window" as the argument against long windows; **51 s is the number to argue about.** The
mitigating fact is structural — the AP branch is only reachable when no saved network associated,
which at home is never.

#### Battery

**The foreground mode has no daily cost** — it runs when the user asks, for as long as they watch, and
it is priced the way A4 prices its session. The table below is for the **unattended variant only**.

One constant, the doc's own: **~130 mA average while the modem is up** (§3A "Battery math",
1 mAh / 28 s = 129 mA; an estimate, not a measurement). A soft AP beacons and transmits, so 130 mA is
a **floor** here, not a midpoint — flag it as such.

| event | active time | cost @130 mA |
| --- | --- | --- |
| failed STA probe (no known network, existing 6 s budget) | 6 s | 0.22 mAh |
| AP window, no peer joins (beacons, torn down at the deadline) | 45 s | 1.63 mAh |
| **worst-case offline sleep-entry (both)** | **51 s** | **1.84 mAh** |
| today's notes-only sleep-entry, for scale (§3A) | 8 s | 0.29 mAh |

At §3's 4 sleeps/day, and pricing the full failed-STA-plus-AP sleep:

| AP window | per sleep | mAh/day | vs the 1500 mAh assumed cell |
| --- | --- | --- | --- |
| 20 s | 0.94 mAh | 3.8 | 0.25 %/day |
| **45 s (default)** | **1.84 mAh** | **7.4** | **0.49 %/day** |
| 90 s | 3.47 mAh | 13.9 | 0.93 %/day |

For calibration against §3A's table: 7.4 mAh/day sits between the "RTC timer wake every 4 h" row
(4.2) and the "every 1 h" row (9.6), and it is ~6x today's notes-only 1.2 mAh/day.

**Two asymmetries make this cost worse than the number suggests, and both belong in the decision.**
First, the AP window costs the same whether or not a phone ever shows up — there are no acks anywhere
in this system (§1), so the reader cannot know a push is pending, and the *empty* window is the normal
one. Second, this cost is incurred **only when there is no known network** — i.e. exactly while
traveling, which is exactly when the user is least able to charge. So: **default off, tunable, and let
the trip be the thing that turns it on.** A 90 s window costs more per day than hourly RTC timer
wakes, which §3A already calls the first configuration where the number stops being free.

#### Honest constraints — read these before scoping A3

- **The phone must be running the app for the whole session.** The proxy is app code. Foreground, or a
  foreground service with a notification; and on aggressive OEM builds a battery-optimization exemption
  besides. **There is no "the reader syncs while the phone is in a pocket with the app killed" story**,
  and A3 should not be described to a user as if there were.
- **Two-`Network` socket binding is the technical risk** (see *Phone side*). Budget device time for it
  specifically; it is the one part that cannot be validated on an emulator.
- **A pending specifier latching onto a 45 s AP is the platform risk.** Unmeasured. It gates only the
  unattended variant — the foreground flow joins because the user is standing there.
- **iOS is harder and A3 is Android-first.** `NEHotspotConfiguration` can join a specific SSID, but
  the peer-route semantics, the background-execution rules and running a listening socket are all
  materially more constrained than on Android. Do not promise parity; ship Android, then re-scope.
- **The reader is awake for all of it.** The X4 latches GPIO13 low on a battery deep sleep
  (`lib/hal/HalPowerManager.cpp:69-78`, Appendix A2's blocker), so there is no "reader wakes itself to
  check the proxy" variant on battery. A3's windows live at sleep-entry or in a foreground mode, same
  as everything else in this doc.
- **Same-radio, same-band.** The reader's AP is 2.4 GHz channel 1 (`CrossPointWebServerActivity.cpp:26`)
  and the phone's cellular data is unaffected, but a phone joined to a 2.4 GHz peer AP has given up its
  own Wi-Fi association — so the *phone* is on cellular for the session. Worth one line in the app UI;
  a user on metered data should know.

#### Footnote: raw direct WS push, retained only as a fallback

The earlier framing of A3 was to push files onto the reader's filesystem directly over the transfer
mode's own protocol — HTTP `mkdir` on 80 plus the chunked WS upload on 81
(`src/services/crosspoint_upload.ts:43-152`, entry points `:165` / `:191`), writing the note frame and
its id sidecar exactly as `sendLoveNoteFrame` does today (`src/services/love_note_sender.ts:361`,
constants `:130-140`).

**It still works and it stays as the manual fallback** — open the app near an awake reader in transfer
mode — because that is shipped code covering the case where the proxy mode is off, unbuilt, or the
window was missed. But it is **no longer the design**, for the three reasons the sections above spell
out: it bypasses the reader's staging (§3A "Staging invariants"), it has no state-file entry so a book
delivered both ways arrives twice, and it requires the reader to run a writable server on an open AP.
The proxy has none of those properties and needs no new wire contract to avoid them.

### Appendix A4 (RECOMMENDED near-term milestone — user-requested): live sync mode, a deliberate mailbox drain

Unlike A1 and A2 this is **not** superseded or optional. It is the cheapest useful thing left in the
messenger stack: no server change, no app change, no new wire contract, and it turns "the book lands
within a day of sleeps" (§3's honest headline) into "the book lands now, because I asked".

**Build it with the base URL as a parameter.** A4 is also the vehicle for A3: the peer-proxy mode is
*this loop pointed at a different origin*, so the only structural requirement A3 places on A4 is that
the base is not read from `SETTINGS` deep inside the loop. Get that right and A3 is an AP raise plus a
base string.

#### What it is

A fourth entry in the reader's network menu, alongside *Join Network* / *Connect to Calibre* /
*Create Hotspot* — **"Mailbox sync"**. Join a saved network via the existing headless connect, then
**loop until Back**: poll `latest.txt` and `books.txt` every few seconds, run the shipped staging
paths whenever something new appears, paint a minimal progress screen, and tear the radio down on
exit. Bounded by a hard session cap as a safety net.

#### Where it slots

The menu is `NetworkModeSelectionActivity`: the enum is
`enum class NetworkMode { JOIN_NETWORK, CONNECT_CALIBRE, CREATE_HOTSPOT }`
(`src/activities/network/NetworkModeSelectionActivity.h:8`), the labels and descriptions are two
parallel `StrId` arrays sized by `MENU_ITEM_COUNT`
(`src/activities/network/NetworkModeSelectionActivity.cpp:87-90`), selection dispatches at `:26-32`
and reports out through `onModeSelected` (`:105-107`). Adding a mode is **one enum value, two
strings, one dispatch arm** — and the whole menu is reached only from `STR_FILE_TRANSFER` on Home
(`src/activities/home/HomeActivity.cpp:303`) via `ActivityManager::goToFileTransfer`
(`src/activities/ActivityManager.cpp:198-200`).

Handle the new mode the way `CONNECT_CALIBRE` is handled — `startActivityForResult` into a dedicated
activity (`CrossPointWebServerActivity.cpp:124-139`) — **not** inside `CrossPointWebServerActivity`
itself, which exists to run a web server this mode does not want. Whether the entry should also
appear directly on the Home menu (`HomeActivity.cpp:303`) rather than one level down under "file
transfer" is a product call; the mode has nothing to do with file transfer and arguably belongs at
the top level.

**A3 adds a second entry to the same menu** — *Sync via phone* — reaching the same activity with an AP
link and a peer base instead of an STA link and the configured one. Two menu entries, one activity: do
not let them fork.

#### The loop

```
1. connect: the existing STA path, saved networks last-connected-first
2. loop until Back, or until the session cap:
     GET {base}/latest.txt   -> new id?      -> stage the note   (incoming/validate/promote)
     GET {base}/books.txt    -> new entry?   -> one book         (BookSync::syncOnLink)
     repaint ONLY if state changed
     wait POLL_INTERVAL (~4 s)
3. WiFi off, teardown, normal return
```

Both polls are tiny: `latest.txt` is ≤128 bytes by contract (§5 G5, `MessageSync.cpp:35`
`MAX_ID_LEN = 128`) and `books.txt` is capped at `MANIFEST_MAX_BYTES = 8192` on the reader
(`BookSync.cpp:45`) against a 3900 B worst legal manifest (§2). **A poll is ~4 KB of payload**, which
is why 4 s is affordable at all.

Notes stage through `probeLatest` → `downloadIncoming` → `promoteIncoming`
(`MessageSync.cpp:128-190`); books through `BookSync::syncOnLink(base, deadline)`
(`BookSync.h:48`, `BookSync.cpp:355`), which already takes an absolute `millis()` deadline and is
already designed to be called on a link somebody else owns.

> **THE ONE PLUMBING GAP, and it is small.** Everything the note side needs is inside an anonymous
> namespace: `namespace {` opens at `MessageSync.cpp:16` and closes at `:300`, so `connectHeadless`
> (`:76-118`), `probeLatest` (`:128-150`), `downloadIncoming` (`:152-158`) and `promoteIncoming`
> (`:160-190`) are all file-static. The public surface is only `syncBeforeSleep` / the three
> wake-check functions / `loadStagedNote` (`MessageSync.h:57-84`), and `syncBeforeSleep` owns the
> radio end to end — it connects (`:307`) and guarantees WiFi is off when it returns, which is the
> opposite of what a live-sync loop needs. **Fix: give the note side the same shape the book side
> already has** — a public `MessageSync::syncOnLink(base, ...)` that does one probe-and-stage pass on
> an already-connected link, plus a public connect entry. `BookSync::syncOnLink` is the template, and
> refactoring toward it also makes `syncBeforeSleep` a thin composition of connect + note pass + hook.

> **G6 bites harder here than anywhere else in this doc.** `SecureHttpClient` is stack-local inside
> `runGetWolf`'s hop loop (`HttpDownloader.cpp:54`), so keep-alive is dead across calls (§5 G6). At a
> 4 s poll that is **two fresh TLS handshakes every 4 s — ~900 in a 30-minute session**, for ~4 KB of
> payload each round. Fix G6 before shipping A4, or raise `POLL_INTERVAL` to hide it. Of the two, fix
> G6: it is the same win §5 already flags for the sleep-entry window.
>
> Note that A3's peer link sidesteps this entirely — the proxy is reached over plain HTTP, so there is
> no handshake to pay (`SecureHttpClient` enters TLS only when the scheme is `https`,
> `SecureHttpClient.h:397`). G6 is a constraint on the *internet* transport only.

**One book per poll, by design.** `syncOnLink` fetches at most one book per call (§3, "One book per
window"), so a mailbox holding five books drains over five poll iterations rather than one pass. That
is correct and needs no change — but state it, or an implementer will expect a single sweep to empty
the box. In live mode pass a generous deadline (the remaining session budget), and note that
`MIN_USEFUL_MS = 4000` (`BookSync.h:61`) — the "skip the window, too little budget left" guard —
should effectively never fire until the session cap is nearly spent.

#### Canonical network: the phone hotspot

**The network A4 is designed around is the user's own phone hotspot, not venue or home WiFi.** Three
reasons, and they compound:

- **Venue WiFi usually has a captive portal, and the reader cannot complete one.** There is no browser
  on the sync path — `HttpDownloader` issues a GET and parses a status line; a portal's 302-to-login
  is just a failed sync. The reader's captive-portal machinery
  (`CrossPointWebServerActivity.cpp:231-237`) runs a portal, it does not solve one.
- **The hotspot works wherever the phone has cellular**, which is the same coverage the *sender* has.
  If the phone can publish to the mailbox, the reader can drain it.
- **It is the only network besides home the reader ever needs saved.** One extra credential covers
  every trip, forever.

The flow:

1. **One-time, at home:** save the hotspot's SSID and password on the reader like any other network
   (`WifiSelectionActivity` via *Join Network*). The hotspot must be **2.4 GHz** — the ESP32-C3 radio
   cannot see 5 or 6 GHz at all, so on Android turn on the hotspot's *Extend compatibility* / AP-band
   2.4 GHz option before saving, or the reader will never find the SSID.
2. **On the trip:** hotspot on from quick settings, reader into *Mailbox sync*. Nothing else. The
   connect path tries **last-connected first** (`MessageSync.cpp:84-91`), so once the hotspot is the
   most recent association it is the first candidate for the rest of the trip, and home WiFi is
   simply an unreachable candidate that fails fast (`:111`).
3. **Drain:** the mailbox is served over the phone's cellular, through the hotspot, into `/books` and
   `/.love-notes`.

> **Android will not let an app turn tethering on, and the app must not pretend otherwise.**
> Programmatic tethering has been restricted since Android 8 — `ConnectivityManager.startTethering` /
> `TetheringManager` are `@SystemApi` behind `TETHER_PRIVILEGED`, which a normal app cannot hold.
> `WifiManager.startLocalOnlyHotspot` (API 26+) *is* callable, and it is **useless here**: the SSID
> and passphrase are system-generated and randomized per session, so the reader's saved credential
> never matches, and it shares no upstream connectivity, so there would be nothing to drain. The
> honest app-side nicety is a **deep link to the tethering settings panel** with a one-line
> instruction — assigned to **M3**, app-side, and guarded with `resolveActivity` because the
> tethering-settings component name is not a documented public intent and OEM builds vary. **No A4
> firmware mechanics change**: `connectHeadless` already connects to any saved SSID, and a hotspot is
> just a saved SSID.

**The hotspot is the near-term answer, not the end state.** It still costs a manual toggle, a saved
credential, and a plan that permits tethering — and the app can never make it one-tap, per the
blockquote above. **A3's peer-proxy mode removes all three** by inverting the link: the reader raises
its own AP and the phone forwards the mailbox to it. Same loop, same poll, same staging; the only
difference is which side is the access point and what string goes in the base. Ship A4 on the hotspot,
then make A3 the default path.

#### Render — repaint on state change, never per poll

Minimal progress screen: notes/books counts, the last item's name, and a `waiting…` line. **Full-frame
repaints only when that state actually changes.**

This is not a preference, it is Appendix A1's blocking finding: there is still **no partial-refresh
path exposed to activities** — `displayWindow` remains commented out at
`lib/GfxRenderer/GfxRenderer.h:179-180`, so an activity can only paint whole frames via
`renderer.displayBuffer()`, scheduled through `requestUpdate()` onto the single render task
(`ActivityManager.cpp:25-39`). A HALF refresh is **1720 ms** (`lib/hal/HalDisplay.h:17`). A screen
that ticked once per 4 s poll would be ~450 full-frame refreshes in a 30-minute session — a strobing
panel, most of a second of every four spent refreshing, for no information. Paint on: connected, note
staged, book promoted, error, exit.

#### Bounds, exit, and the two things that will bite

- **Session cap ~30 min**, enforced against a `millis()` deadline in the loop. Same discipline §5 G7
  demands: never lean on the 60 s per-socket-op timeout (`HttpDownloader.cpp:32`) as a bound.
- **Assert `preventAutoSleep()`** (`src/activities/Activity.h:45`, aggregated by
  `ActivityManager::preventAutoSleep()`, `src/activities/ActivityManager.h:106`, consumed at
  `main.cpp:591`) for the whole session, or the inactivity timer sleeps the device mid-drain. The
  precedent is right there in the same condition: `MessageSync::wakeCheckActive()` is in that `if` for
  exactly this reason.
- **Exit through `silentRestart()`**, like every other WiFi activity (`CrossPointWebServerActivity.cpp:99-107`,
  `main.cpp:142-154`). A live-sync session is a *long* WiFi session with SD writes and possibly a
  multi-MB streamed download, so it fragments the heap at least as badly as transfer mode does. Unlike
  §3A's Path B — where a reboot would trample the launcher the user just woke into — the user
  explicitly entered a mode here and expects to land back at Home, which is exactly where
  `silentRestart()` goes (`main.cpp:144`). **Do not skip it.**

#### Why this is worth doing

- **It works across the internet.** The WS transfer mode requires the phone and reader on the same
  LAN (or the reader's own AP). A4 requires only that both ends reach the mailbox, so **the sender can
  be anywhere** — a different city, a different country. That is a capability the reader does not have
  today in any mode.
- **Zero server and zero app changes.** The endpoints are shipped and green (§2 and the banner at the
  top of this doc), the publish flows are shipped app-side (`src/services/mailbox_client.ts:142-154`,
  `publishLoveNote` at `:677`). A4 is firmware-only.
- **It reuses the staging invariants verbatim**, so it cannot produce a torn file: notes go
  incoming → validate → promote (§3A "Staging invariants"), books go through `/books/.incoming/{id}`
  with the exact-size promote gate (§4).
- **RAM-safe by construction.** It is a foreground activity, so no EPUB is resident — the same
  sequential property §3A's Path B has to work hard to guarantee, obtained here for free.
- **It de-risks A3 and §3's option C.** Every genuinely new piece — Range plumbing, resume-append,
  promote gate, manifest parse — gets exercised on a screen where failures are visible, and real
  throughput gets measured instead of guessed at 30 KB/s.

#### Interaction with the lock-screen model

**A note staged during live sync does not appear during live sync.** §3A routes every note through the
sleep screen: the staged frame takes the panel at the next sleep-entry, via
`SleepActivity::renderNoteSleepScreen()` (`SleepActivity.cpp:88-95`, called at `:49`), for that one
sleep. Live sync stages it and says so on the progress screen; the panel shows it when the user next
puts the device down, and the wallpaper is back the sleep after. Staging here does not touch
`messageLastDisplayedId` — a sync that stages five notes still leaves exactly the newest one holding an
unspent turn. Resist the temptation to render it inline — that reintroduces exactly the interrupting-note
model §3A deleted, and `MessageDisplayActivity` paints `FULL_REFRESH`
(`MessageDisplayActivity.cpp:40`), the multi-flash waveform.

**Books are the opposite: they land in `/books` immediately** and are readable the moment the mode
exits, because a book is a file in a library and not a screen.

#### Optional niceties — flagged, not required

- **`If-None-Match` / ETag on the polls.** Would trim a poll to a `304`. **Not worth it:** the payload
  is already ~4 KB, the handshake (G6) dominates by orders of magnitude, and it means a server change
  that cuts against §2's blanket `cache-control: no-store, no-cache, must-revalidate` — the manifest
  is deliberately uncacheable because a cached one pins the reader on a stale book set. Fix G6 instead.
- **A "synced N items" summary on exit.** One extra full-frame paint on a screen the user is already
  looking at, and it is the only place in the whole system where the user gets confirmation of
  anything — there are no acks by design (§1). Cheap, and the best user-visible value per line of code
  in A4.

---

## 4. Partial-file invariants

The rule: **a torn epub must never be visible to the library.** Mirror the note staging pattern
exactly (`MessageSync.cpp:20` `INCOMING_FRAME`, `:167` download, `:178-188` validate, `:191-196`
promote) — it already encodes every one of these.

1. **Download into a staging path, never the final one.** `/books/.incoming/{id}`, created with
   `Storage.ensureDirectoryExists` (`lib/hal/HalStorage.h:31`) — `openFileForWrite` does not create
   parents, which is exactly the trap `MessageSync.cpp:164-166` documents.
2. **Two independent reasons the staging file is invisible.** The `.incoming` dir is dot-prefixed →
   skipped by the browser unless `SETTINGS.showHiddenFiles` (`FileBrowserActivity.cpp:41`); and the
   staging file has **no extension** → rejected by the browser's allowlist even with hidden files on
   (`FileBrowserActivity.cpp:55-59`, `.epub/.xtc/.txt/.md/.bmp`, case-insensitive via
   `lib/FsHelpers/FsHelpers.cpp:140-154`). A flat `/books/incoming.{id}` also works (no listed
   extension) but relies on the allowlist alone — prefer the dot-dir *and* no extension.
3. **Promote only on an exact size match** against the manifest's `bytes`, read back off SD
   (`HalFile::size()`, `HalStorage.h:77`). This is the sole integrity gate the contract affords (§2,
   no hash) and it is the direct analogue of the note path's `incomingSize != frameBufferSize` check
   (`MessageSync.cpp:183-188`). A short file is a resume-in-progress, not a failure — keep it.
4. **`rename` does not overwrite.** It delegates to SdFat `vol().rename()`
   (`freeink-sdk/libs/hardware/SDCardManager/include/SDCardManager.h:61`) — which is why the note path
   removes the destination first (`MessageSync.cpp:191`). Do the same, and pick a non-colliding name
   the way `buildReadFolderDestination` does (`EpubReaderActivity.cpp:99-118`) rather than clobbering
   a book the user already has (it suffixes ` (2)`, ` (3)`… up to 100).
5. **Write the state entry AFTER the rename succeeds**, never before — same ordering as
   `writeFile(CURRENT_ID)` at `MessageSync.cpp:197`. State-then-rename would mark a book done that
   isn't there, and it would never be retried.
6. **Never delete the staging file on a transport failure.** This is the single biggest departure from
   the note path, where deleting on failure is correct because a frame is one-shot. For books the
   partial file *is* the resume state. See gap G3 — the current `downloadToFile` deletes it three
   different ways.
7. **Sanitize the filename on the reader too.** The server rejects traversal, but the reader must not
   trust a manifest line it read over plain http on someone's hotspot. Reject anything containing `/`,
   `\`, or a leading `.`, and require a case-insensitive `.epub` tail
   (`FsHelpers::hasEpubExtension`, `FsHelpers.cpp:166`) — a name that fails the browser's allowlist
   would download successfully and then be invisible forever, which looks exactly like a sync bug.

---

## 5. `HttpDownloader` gaps — the actual work list

Read `src/network/HttpDownloader.cpp` before starting. **The live path is `runGetWolf`**, not the
`esp_http_client` path: every shipping env compiles wolfSSL (`platformio.ini:41`
`-DFREEINK_NET_WOLFSSL=1` in `[base] build_flags`, expanded by all five envs at `:154 :165 :175 :185
:202`), and `runGetSecure` dispatches on that flag (`HttpDownloader.cpp:225-229`). The
`#if !defined(FREEINK_NET_WOLFSSL)` branch (`:112-217`) is dead code — fix it for symmetry if you
like, but it is not what runs.

**G1 — no way to set a request header.** `fetchUrl`/`downloadToFile` take only URL + basic-auth
credentials (`HttpDownloader.h:29-46`). No `Range` can be expressed. The plumbing exists one layer
down: `SecureHttpClient::addHeader` is public (`SecureHttpClient.h:121-123`) and `runGetWolf` already
calls it for `Authorization` (`HttpDownloader.cpp:65-69`). **Fix:** thread an optional
`{name, value}` header list (or a plain `size_t rangeStart`) through `fetchUrl`/`downloadToFile`/`Sink`
into both `runGet*`. Prefer an explicit `rangeStart` over a generic header bag — it keeps the 206
bookkeeping in G2 honest.

**G2 — `206` is treated as an error, twice.** `runGetWolf` fails the whole request on any non-200
(`HttpDownloader.cpp:96-99`) *and* its streaming callback silently discards every body byte when the
status isn't 200 (`:74` — `if (http.getStatus() != 200) return true;`). The `esp_http_client` path has
the same check (`:172-176`). Note the layer below is already fine: the status line parse handles any
code (`SecureHttpClient.h:228`), `Content-Length` is captured normally (`:244-246`), and `readFixed`
(`:278-279`) streams exactly the slice length. **Fix:** accept `200` and `206`; accept the body on
both.

**G3 — `downloadToFile` destroys resume progress three ways.**
`HttpDownloader.cpp:266-268` removes an existing `destPath` *before* opening;
`:285-288` removes it on any non-OK result; `:289-293` removes it when `downloaded == 0` — which is
precisely what a `416` or an empty `206` produces. **Fix:** add a resume mode that does none of the
three, and give the caller a distinguishable error so a `416` ("restart from 0") is not confused with
a transient `5xx` ("keep the partial, retry next window"). Today both collapse into `HTTP_ERROR`
(`HttpDownloader.h:19-24`).

**G4 — no append.** `Storage.openFileForWrite` is hardcoded `O_RDWR | O_CREAT | O_TRUNC`
(`freeink-sdk/libs/hardware/SDCardManager/src/SDCardManager.cpp:308`), so the very first write of a
resumed download truncates everything already fetched. **Fix:** open through the raw-oflag path
`Storage.open(path, O_WRITE | O_CREAT)` (`lib/hal/HalStorage.h:33`; precedent
`src/util/Dictionary.cpp:315`) and `seekSet(existingSize)` (`HalStorage.h:82-83`) before the first
sink write. Seek explicitly rather than trusting an `O_APPEND`-style flag — the SdFat oflag set is not
vendored in this tree, so verify whatever you use compiles on-target.

Also fix the progress math while you are there: `sink.total` is set from `Content-Length`
(`HttpDownloader.cpp:75`, and `:180` on the dead path), which on a `206` is the **slice** length, not
the file size. A resume at 90% would render as a bar starting from 0. Seed `sink.downloaded` with the
resume offset and take `total` from `Content-Range`, readable via
`SecureHttpClient::getHeader("content-range")` (`SecureHttpClient.h:306-313`).

**G5 — `fetchUrl(std::string&)` is unbounded.** It appends the whole body to a heap string with no cap
(`HttpDownloader.cpp:241-251`). Fine for `latest.txt` (≤128 bytes by contract); **not** fine for
`books.txt` off a network the reader does not control, with ~50 KB of heap. **Fix:** parse the
manifest through the `DataCallback` overload (`HttpDownloader.h:38`, `:253-259`) line-by-line, abort by
returning `false` past a hard byte cap (8 KB is 2× the worst legal manifest), and cap the line count at
`MAX_BOOKS`.

**G6 — a TLS handshake per call.** `SecureHttpClient` is stack-local inside `runGetWolf`'s hop loop
(`HttpDownloader.cpp:54`), destroyed each iteration, so keep-alive (`SecureHttpClient.h:107`, on by
default) is dead across calls: `latest.txt` + `current.frame` + `books.txt` + a book chunk = four
handshakes in one window. **Fix:** hoist a reusable client for the duration of a sync window. This is
the single biggest win in the fixed cost that §3's window math charges 8 s for, and it benefits the
existing note path too.

**G7 — no `HEAD`, and no wall-clock budget.** `HttpDownloader` only issues GET, though
`SecureHttpClient::sendRequest` takes an arbitrary method (`SecureHttpClient.h:132-134`) — worth
adding if you ever want a size probe without the manifest. And there is no overall deadline: the only
bound is a 60 s **per-socket-op** timeout (`HttpDownloader.cpp:32`), so one stalled read can hold the
window ~60 s regardless of `B`. **Fix:** the books budget must be enforced by the caller via
`cancelFlag` (`HttpDownloader.h:45`) driven off a `millis()` deadline — the same pattern
`connectHeadless` uses for its connect budget (`MessageSync.cpp:90-99`). Do not rely on the socket
timeout as a window bound.

---

## 6. URL budget — a non-issue, and why

The reader stores only the **base**, in `char messageSyncUrl[128]`
(`src/CrossPointSettings.h:245`), copied by `copyToField` with `strncpy(dest, src, maxLen - 1)`
(`src/CrossPointSettings.cpp:25`, inside `copyToField`) → the real ceiling is **127 chars** and a 128th is silently
truncated. That is already enforced app-side
(`mailbox/src/core.js` `READER_URL_MAX_LEN` / `checkReaderUrlBudget`). Books change
nothing there: no new base, no second URL to provision.

Suffixes are composed at runtime as heap `std::string`s — `baseUrl()` returns `std::string`
(`MessageSync.cpp:52-56`) and callers do `base + SUFFIX_ID` (`:143`). The longest books URL is
`base(127) + "/books/"(7) + id(64)` = **198 chars**, built the same way and passed straight into
`SecureHttpClient::begin` → `writeRequest`, which also builds a `std::string`
(`SecureHttpClient.h:431`). No fixed buffer anywhere on that path. `MAX_LINE = 4096`
(`SecureHttpClient.h:556`) bounds **response** header lines only.

Do **not** add a second settings field for a books base. One capability URL, one budget, one thing to
provision.

---

## 7. The server half — what it actually did

This section was the brief. It is now a record; the three constraints it named were the real ones.

- **`parsePath` grew a fourth segment, structurally.** It accepts 3 **or** 4 segments and reports the
  fourth as `sub`, *omitted* rather than null when absent — so every three-segment path still parses to
  exactly `{boxId, leaf}` and `handleRequest` 404s the moment a `sub` appears on any leaf other than
  `books`. Five segments still fail to parse at all, which is what keeps
  `/m/{box}/books/{id}/../..` a plain 404 without a blocklist. `/latest.txt/extra` is still a 404, pinned.
- **The body cap is now per route, not global.** `requestBodyLimit(method, path)` returns
  `MAX_BOOK_BYTES` for `POST /books` and `MAX_REQUEST_BODY_BYTES` (64 KB, unchanged) for everything
  else; both adapters call it instead of reading the constant. Raising the global cap to fit a book
  would have let a bogus 24 MB `/publish` be buffered before the exact-52272-byte check rejects it.
- **`X-Filename` is capped at 120 and rejected, never truncated** — §2 has the full reject/replace
  split. The manifest's worst-case body is re-derived from it above (3900 B).

Two things the brief did not anticipate:

- **The dev server buffers a `POST /books` body whole** (24 MiB peak) and its systemd unit on the devbox
  sets `MemoryMax=256M`. Enough for one upload at a time; **not** enough for a resident library, which
  is why `--data-dir` matters as soon as books are in play (the in-memory store's worst case is
  `MAX_BOOKS × MAX_BOOK_BYTES` = 480 MB). True streaming-to-disk on the publish path would remove the
  spike and is the obvious next hardening if a real 24 MiB upload is ever exercised there.
- **That spike now costs a valid bearer token**, which it did not at first. `requestBodyLimit` keys the
  cap off method+path, so it cannot see credentials, and both adapters used to buffer before
  `handleRequest` reached the auth check — an anonymous 24 MiB `POST /books` was accepted in full and
  then answered `401`, at roughly 3x the body in peak memory. Since the boxId is a **read** capability
  that travels in cleartext by design, that made a handful of concurrent anonymous requests an
  OOM-kill of the service that also serves the hardware-proven notes path. Both adapters now call
  `writeAuthPreflight` immediately after `requestBodyLimit` whenever the route's limit exceeds
  `MAX_REQUEST_BODY_BYTES`, and return the core's own `401`/`503` without reading the body.
  Measured on a real socket after the fix: three consecutive anonymous 24 MiB uploads were cut off
  after 0.7–1.7 MiB each and moved RSS 59336 → 59492 kB in total (+156 kB), against +55 MB for a
  single such request before it. The notes routes are deliberately **not** pre-authenticated — 64 KB is
  cheap to buffer, and an oversize `/publish` must keep answering `413`, not `401`.
- **`stat`/`getRange` were added to the store contract as an OPTIONAL pair.** With them (the dev
  server's file store) a ranged read touches only the requested window — the difference between a 64 KB
  and a 24 MB allocation per resume request. Without them (Workers KV, which has no ranged read) the
  value is fetched once and sliced. `Range` *logic* stays entirely in `core.js`; the store only reads
  bytes. A test asserts both paths return identical bytes for the same range, because a reader
  stitching windows together cannot tell them apart and must not have to.

Deliberately **not** done, so nobody assumes otherwise: no content hash / ETag (§2), no streaming
publish (above), no CORS (the client is React Native), and no multi-range (§2).
