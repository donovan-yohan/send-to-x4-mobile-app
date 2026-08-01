# Xteink mailbox

A small Cloudflare Worker that holds **one love-note frame** and **one note id**
per mailbox (plus the immediately previous frame — see
[storage layout](#storage-layout-and-publish-ordering)), **up to 20 epubs**
([books](#books-epub-delivery)) and **up to 8 pending sleep screens**
([wallpapers](#wallpapers-sleep-screen-delivery)). The CrossPoint reader
(messenger fork) polls it at deep-sleep entry; the phone app publishes to it. It
exists because the reader is invisible on the network while asleep — the phone
cannot push to it, so something durable has to sit in the middle.

```
 phone app  --POST /publish   (bearer)-->  [ mailbox ]  <--GET /latest.txt--------  reader
            --POST /books     (bearer)-->               <--GET /current.frame-----  (at deep-sleep entry)
            --POST /wallpaper (bearer)-->               <--GET /books.txt---------
                                                        <--GET /books/{id}--------  (Range: resume)
                                                        <--GET /wallpaper.txt-----
                                                        <--GET /wallpaper/{id}----  (Range: resume)
```

The point of all of it: **after one-time provisioning the reader never re-enters
transfer mode.** Notes pull-sync today (hardware-proven); books and wallpapers
ride the same mailbox, the same capability URL and the same token, so nothing new
gets provisioned on the device when the reader-side milestones land.

Wallpaper used to be **direct-LAN only** (the app pushed a BMP straight at the
reader's `/sleep.bmp` or `/.sleep/`), which meant it worked only while phone and
reader shared a network *and* the reader was awake. Over the mailbox, a host can
set the reader's sleep screen from anywhere and the reader collects it on its own
sync windows.

| file | role |
|---|---|
| `src/core.js` | the entire wire contract, platform-free, no imports |
| `src/worker.js` | Cloudflare glue: KV -> store, `env.WRITE_TOKEN` -> config |
| `wrangler.jsonc` | deploy config (two placeholders to fill) |
| `../scripts/mailbox_dev_server.mjs` | node http server over the **same** `core.js` |
| `../scripts/mailbox-core.test.js` | tests against `core.js` directly; runs in `npm run ci` |
| `../scripts/mailbox-dev-server.test.js` | the dev server's body bound + file store |

`core.js` is shared on purpose: a behaviour proven by the test file holds on
both the Worker and the local dev server, because neither adapter contains a
routing, validation or ordering decision of its own.

---

## Wire contract

Base URL: `{origin}/m/{boxId}` — `boxId` is 22–64 url-safe chars
(`[A-Za-z0-9_-]`). `generateBoxId()` draws **16 CSPRNG bytes = 128 bits**,
encoded as 22 base64url characters. (22 base64url chars can *encode* 132 bits;
only 128 of them are random.)

### Reader reads — **no auth**

| request | response |
|---|---|
| `GET {base}/latest.txt` | `200 text/plain`, body = the note id, **or a zero-length body meaning "no note"** |
| `GET {base}/current.frame` | `200 application/octet-stream`, **exactly 52272 bytes** — always the frame belonging to the id `latest.txt` reports; `404` when the box has no note, or when a replica has the pointer but not yet that note's frame |

The empty-body-not-404 rule is not a style choice. `crosspoint-reader`
`src/network/MessageSync.cpp` treats any non-200 as a failed sync (logged error,
WiFi torn down) and an empty body as "mailbox empty", so a 404 on an empty box
would produce an error on **every** wake.

The 52272 (= 528 rows x 99 bytes, 1-bit, MSB first) is re-checked by the
firmware, which silently discards anything else — so a wrong size is enforced on
the **write** path here, where the app can still see the error.

### App writes — **bearer auth**

| request | response |
|---|---|
| `POST {base}/publish`<br>`Authorization: Bearer <writeToken>`<br>`Content-Type: application/octet-stream`<br>`X-Note-Id: <id>`<br>body = 52272 bytes | `200 {"ok":true,"id":…,"bytes":52272,"updatedAt":…}` |
| | `401` bad/missing token · `400` bad id or wrong size · `413` body > one frame · `503` storage failure (`published:false`) |
| `GET {base}/status` + bearer | `200 {"latestId":…, "bytes":…, "updatedAt":…, "books":[{id,filename,bytes}], "wallpapers":[{id,target,filename,bytes}]}` (nulls/0/`[]` when empty) |

`X-Note-Id`: trimmed exactly the way the firmware's `trimId()` trims (space, tab,
CR, LF), then required to match `[A-Za-z0-9._~-]{1,64}`. Ids are **rejected, never
truncated** — a truncated id still looks valid to the reader and would collide
with every other id sharing that prefix, permanently deduping later notes away.

Everything answers `Cache-Control: no-store`. That matters most for
`latest.txt`: it is the single byte that decides whether the 51 KB frame is
fetched at all, and a cached copy pins the reader on the old id.

### Storage layout and publish ordering

Note keys per box, at most three (books and wallpapers add their own — see
[books storage layout](#books-storage-layout-and-write-ordering) and
[wallpaper storage layout](#wallpaper-storage-layout-and-write-ordering)):

| key | holds |
|---|---|
| `box:{id}:meta` | `{v, latestId, previousId, bytes, updatedAt}` — the id pointer |
| `box:{id}:frame:{noteId}` | the current note's 52272 bytes |
| `box:{id}:frame:{previousNoteId}` | the immediately previous note, retained |

**The frame key carries the note id, and that is load-bearing** — see
[KV consistency](#known-limitation-kv-consistency-is-a-delay-not-a-torn-read)
below. `current.frame` resolves the id from `meta` and *derives* the frame key
from it, so the bytes it serves always belong to the id it just read.

Publish writes the **frame first, the id pointer second**, always, then
collects any frame older than the retained pair. Because `frame:{new}` is a
different key from `frame:{old}`, there is no window in which the pointer and
the bytes disagree at the origin at all — an observer between the two writes
sees the old id *and* the old bytes. Pinned by the interleaving tests in
`scripts/mailbox-core.test.js`.

Retaining one predecessor is what makes a lagging replica benign: it answers
with the old id and the old frame (a consistent, one-cycle-late pair) instead of
404ing. `delete` is optional on the store contract — a store without it just
accumulates frames, which is a cost, never a correctness problem.

---

## Books (epub delivery)

Additive: **no note route, note key or note response changed shape.** A box that
has only ever held notes is byte-identical in the store to what it was before
this route existed, and a books-only box still answers `latest.txt` with a
zero-length 200 (the reader syncs notes on every wake regardless).

### Reader reads — **no auth** (the `boxId` is the capability, as above)

| request | response |
|---|---|
| `GET {base}/books.txt` | `200 text/plain`, one line per book, **newest first**, zero-length body when the box holds none |
| `GET\|HEAD {base}/books/{id}` | `200 application/epub+zip` + `Accept-Ranges: bytes`; with a `Range` → `206` + `Content-Range`; unsatisfiable → `416` + `Content-Range: bytes */{size}` |

**Manifest format is a byte-exact contract** (pinned by
`scripts/mailbox-core.test.js`):

```
{id} {bytes} {filename}\n
```

No header line, no trailing blank line, LF (not CRLF). Ids and byte counts
contain no spaces *by construction*, and the filename is the **rest of the
line** — so a reader scans to the first two spaces and takes the remainder, and
a filename containing a space still round-trips. Filenames are forced to
printable ASCII, so one character is one byte and a C string walk cannot
disagree with `Content-Length` about where the fields are.

The reader **diffs this against its local `/books`** and downloads what is
missing. There are **no server-side acks, deliberately**: reader-side state (what
is actually on the SD card) is authoritative, and an ack would be a write the
reader has to make inside its wake window plus a state that can disagree with the
card after a swap or a failed write.

### `Range` is the resume mechanism, not an optimisation

A wake window is seconds long and on battery, so a 3 MB epub arrives over
several windows, each asking for the bytes after what the card already holds.

| `Range` | answer |
|---|---|
| absent | `200`, whole body |
| `bytes=N-M` | `206`, that slice; `M` past the end is **clamped** (so a fixed window size needs no prior knowledge of the length) |
| `bytes=N-` | `206`, N to the end |
| `bytes=-N` | `206`, the last N bytes |
| `bytes=N-` with `N >= size`, `bytes=M-N` with `N < M`, any range on an empty body | `416` + `Content-Range: bytes */{size}` |
| multi-range (`bytes=0-1,4-5`), unknown unit, garbage | **ignored** → `200` full body |

Multi-range is ignored rather than implemented: `multipart/byteranges` is a
second body format for an ESP32 to parse and a resume needs exactly one range.
Answering 416 for a malformed header would break a client that could perfectly
well take the whole file, and RFC 9110 explicitly permits ignoring it. A
*well-formed but unmeetable* range is 416 **with the total size**, because
without the total the client has nothing to correct its offset to and would retry
the same bad range on every wake, forever.

`If-Range` is **not** honoured — nothing here publishes an ETag or
`Last-Modified`, so there is no validator to compare. Instead: **a book id is
meant to be immutable.** Re-POSTing the same id is supported (that is what a
retry does) and overwrites the blob, so a reader mid-resume must compare the
total in every `Content-Range` against the `bytes` it read from `books.txt` and
restart when they disagree. The app should mint a new id for different content
rather than lean on that.

### App writes — **bearer auth** (the same `WRITE_TOKEN`)

| request | response |
|---|---|
| `POST {base}/books`<br>`Authorization: Bearer <writeToken>`<br>`Content-Type: application/octet-stream`<br>`X-Book-Id: <id>`<br>`X-Filename: <name.epub>`<br>body = the epub | `200 {"ok":true,"id":…,"filename":…,"bytes":…}` |
| | `401` bad/missing token · `400` bad id/filename or empty body · `413` over the cap · `503` storage failure (`published:false`) |
| `DELETE {base}/books/{id}` + bearer | `200 {"ok":true,"id":…,"filename":…}` · `404` unknown id |

`X-Book-Id` uses the **note id charset** (`[A-Za-z0-9._~-]{1,64}`), plus `.` and
`..` are refused — the id becomes a store key, and a store key becomes a
filesystem path on the dev server.

`X-Filename` is split between **reject** and **replace**, on purpose:

- **rejected** (400): path separators, control characters (an internal LF would
  forge a manifest line), a leading `.`, a missing `.epub`, over
  `BOOK_FILENAME_MAX_LEN` (120). Each of these means the caller asked for
  something structurally different from what we would store, and silently storing
  a different file is how a user ends up with a book they cannot find.
- **replaced** with `_`: FAT-reserved punctuation (`" * : < > ? |`) and anything
  outside printable ASCII. Cosmetic, and the name stays recognisable.
  `Café: Frappé*.EPUB` → `Caf__ Frapp__.epub` (the extension is lowercased so one
  book cannot become two files on a case-insensitive card).

### Caps

| constant | value | why |
|---|---|---|
| `MAX_BOOK_BYTES` | **24 MiB** (25165824) | Workers KV caps a single **value** at 25 MiB. The brief asked for 30 MB; a 30 MB epub would be accepted, answered `200`, and then fail its `kv.put` — the app reporting success for a book the reader can never see. 24 MiB is inside the ceiling and ~5x the largest realistic epub. **One** constant, so a book that works on the LAN works on Workers unchanged. |
| `MAX_BOOKS` | **20** per box | The manifest is fetched in full on every wake window, so it cannot be unbounded. The 21st book **evicts the oldest** — index entry *and* blob. |
| notes body cap | **64 KB**, unchanged | Raising `MAX_REQUEST_BODY_BYTES` globally to fit a book would let a bogus 24 MB `/publish` be buffered before the exact-size check rejects it. Adapters call `requestBodyLimit(method, path)` instead, which returns the book cap **only** for `POST /books`. |

A new book also **replaces any entry with the same filename** (case-insensitively,
because the SD card is), dropping the old blob. Two manifest entries naming one
file would make the reader's filename diff unresolvable, and re-sending a book
under a fresh id would otherwise advertise the old copy forever.

### Books storage layout and write ordering

| key | holds |
|---|---|
| `box:{id}:books:index` | `{v, books:[{id, filename, bytes, updatedAt}]}` — newest first |
| `box:{id}:book:{bookId}` | one epub's bytes |

Content-addressed by book id, for the same reason frames are: the bytes served
are selected *by* the id inside one request, so a replica holding the manifest
but not yet the blob can only 404 — never hand out another book's bytes under
this name. (`book:` vs `books:` keeps the dev server's `:`→`_` filename mapping
injective.)

- **publish: blob first, manifest second.** The manifest must never advertise a
  book whose bytes are absent — the reader budgets a whole wake window per
  download, and on KV the two keys replicate independently.
- **delete: manifest first, blob second.** The mirror image, for the mirror
  reason.
- **GC last, never fatally.** Eviction and replacement are bounded by `MAX_BOOKS`
  (no listing, no scan). A failed manifest write reports `published:false` and
  leaves the orphaned blob in place *deliberately* — a `put` that threw may still
  have landed, and deleting the bytes of a manifest that actually moved would turn
  a live book into a permanent 404. Find any that accumulate with
  `npx wrangler kv key list --binding MAILBOX_KV --prefix 'box:<id>:book'`.

A stored manifest entry is re-validated on **read**, and dropped unless the
filename round-trips through the sanitizer unchanged — so a corrupted value can
never emit a forged line or a name this contract would not mint. A corrupt or
unreadable manifest degrades to an **empty library** (a normal wake), never a 500.

### `stat`/`getRange`: the optional half of the store contract

A ranged read has two implementations and they must be indistinguishable:

- **with** `store.stat` + `store.getRange` (the dev server's file store) only the
  requested window is read off the disk;
- **without** them (Workers KV has no ranged read) the value is fetched once and
  sliced.

The Worker deliberately does **not** implement them: KV would still pull the whole
value, so it would only hide the cost. That is also why one ranged request on
Workers costs one full value read — and why `MAX_BOOK_BYTES` is what KV can hold.

---

## Wallpapers (sleep-screen delivery)

Additive again: **no note route, note key, book route or book key changed shape.**
A box that has only ever held notes and books is byte-identical in the store to
what it was before this route existed.

Structurally these are the books routes, with **exactly three** differences:

1. an entry carries a **target** telling the reader which file to write;
2. a new `primary` **supersedes** the pending one instead of stacking;
3. the manifest is rendered **newest last**.

Everything else — ordering, eviction, GC, `Range`, auth placement, the
degrade-to-empty read path — is the same code shape, because the books version
is the one that has been reviewed against the firmware's wake-window behaviour.

### Reader reads — **no auth** (the `boxId` is the capability, as above)

| request | response |
|---|---|
| `GET {base}/wallpaper.txt` | `200 text/plain`, one line per pending wallpaper, **newest last**, zero-length body when nothing is pending |
| `GET\|HEAD {base}/wallpaper/{id}` | `200 image/bmp` + `Accept-Ranges: bytes`; with a `Range` → `206` + `Content-Range`; unsatisfiable → `416` + `Content-Range: bytes */{size}` |

**Manifest format is a byte-exact contract** (pinned by
`scripts/mailbox-core.test.js`):

```
{id} {bytes} {target} {filename}\n
```

`target` is `primary` or `set`. `filename` is the literal **`-`** for every
`primary` — a *positional placeholder*, not a name: the line is four
space-separated fields and the parser takes the fourth as "the rest of the
line", so an empty field would move the LF into it. `-` is unambiguous because a
`set` filename must end in `.bmp` and therefore can never *be* `-`.

Ids, byte counts and targets contain no spaces by construction, so a reader scans
to the first three spaces and takes the remainder — a filename containing a space
still round-trips. Filenames are forced to printable ASCII, same as books.

**Newest LAST, the opposite of `books.txt`, and that is the point.** The reader
applies these **in the order it reads them**, and the last write to `/sleep.bmp`
wins. Newest-last means a reader that drains the whole manifest in one window
*ends* on the newest primary; newest-first would end on the oldest and silently
show a stale screen.

### Reader-side application

| target | destination |
|---|---|
| `primary` | `/sleep.bmp` — the active sleep screen |
| `set` | `/.sleep/{filename}` — the rotation folder |

The reader **tracks applied ids** so it never re-downloads one — the same
done-state pattern `BookSync` uses. There are **no server-side acks** here
either, for the reasons spelled out for books: reader-side state is
authoritative, and an ack is a write the reader would have to make inside its
wake window.

`Range` behaves identically to books — see
[that table](#range-is-the-resume-mechanism-not-an-optimisation); it is not an
optimisation here either, since a full-bleed 8bpp BMP is ~1.1 MB and a wake
window is seconds long.

### App writes — **bearer auth** (the same `WRITE_TOKEN`)

| request | response |
|---|---|
| `POST {base}/wallpaper`<br>`Authorization: Bearer <writeToken>`<br>`Content-Type: application/octet-stream`<br>`X-Wallpaper-Id: <id>`<br>`X-Wallpaper-Target: primary\|set`<br>`X-Filename: <name.bmp>`<br>body = 8-bit grayscale BMP | `200 {"ok":true,"id":…,"target":…,"filename":…,"bytes":…}` |
| | `401` bad/missing token · `400` bad id/target/filename or empty body · `413` over the cap · `503` storage failure (`published:false`) |
| `DELETE {base}/wallpaper/{id}` + bearer | `200 {"ok":true,"id":…,"target":…,"filename":…}` · `404` unknown id |

- **`X-Wallpaper-Id`** — the note/book charset (`[A-Za-z0-9._~-]{1,64}`), `.` and
  `..` refused. Same reason: it becomes a store key, and a store key becomes a
  filesystem path on the dev server.
- **`X-Wallpaper-Target`** — a closed two-member enum. Trimmed and case-folded to
  the canonical lowercase form; anything else is **400, never a default**.
  Defaulting an unrecognised value would overwrite a user's active sleep screen
  with something they meant to add to the rotation.
- **`X-Filename`** — **required** when `target=set`, **ignored** when
  `target=primary` (not "optional"). A primary has exactly one destination, so
  honouring a name there would create a second source of truth for where the
  bytes land. Same reject/replace split as `X-Filename` on books, with `.bmp`
  instead of `.epub`; the extension is lowercased so one image cannot become two
  files on a case-insensitive card.

**`filename` is `null` — not `"-"` — everywhere JSON is spoken** (the `POST`
response, `DELETE`, and `/status`). The `-` exists only for the text manifest's
positional parser; putting it in JSON would invent a filename the reader must
not use.

The body is **not** validated as a BMP. The mailbox is a byte pipe, exactly as it
is for epubs — the encoder on the app side and the renderer on the reader side
own the format.

### Caps and retention

| constant | value | why |
|---|---|---|
| `MAX_WALLPAPER_BYTES` | **4 MiB** (4194304) | A 1056-long-side 8bpp BMP is ~1.1 MB, so this is ~4x headroom for a larger source or a padded row stride, and it stays far under the 25 MiB Workers KV **value** ceiling. Same rule as books: a body we accept must be a body `kv.put` can store, or the app reports success for something the reader can never see. |
| `MAX_WALLPAPERS` | **8** pending per box | Smaller than `MAX_BOOKS` because a wallpaper is applied and forgotten, not a library kept in sync — eight at ~1.1 MB is already more than a reader drains in one window. The 9th **evicts the oldest**, entry *and* blob. |
| notes body cap | **64 KB**, unchanged | Unchanged, for the reason books did not change it either. |

**Primary supersede.** Publishing `target=primary` **replaces** any earlier
primary still in the index — entry and blob. Two pending primaries would make the
reader spend a wake window downloading ~1.1 MB it is about to overwrite, to end
up exactly where the newest one alone would have put it. At most one primary is
ever pending, and that invariant is re-checked on **read**, so a corrupted index
cannot break it either.

`set` items do **not** supersede each other, **not even under the same
filename** — unlike books. Books collapse same-filename entries because the
reader's diff against its SD card would otherwise be unresolvable; a wallpaper
has an id-based done-state and no filename diff, so collapsing them would
silently drop an item the caller asked to queue. Re-POSTing the **same id** does
replace, since that is what a retry is.

### Wallpaper storage layout and write ordering

| key | holds |
|---|---|
| `box:{id}:wallpapers:index` | `{v, wallpapers:[{id, target, filename, bytes, updatedAt}]}` — **newest first** in storage; the wire reversal happens in `renderWallpaperManifest`, the one place that knows about it |
| `box:{id}:wallpaper:{wallpaperId}` | one BMP's bytes |

Content-addressed by wallpaper id, for the reason frames and books are. The dev
server's `:`→`_` filename mapping stays **injective across all four namespaces**:
the id charset excludes `_`, so no id can spell `s_index` and turn
`wallpaper:{id}` into `wallpapers_index`. Pinned by a test that flattens the
whole key set of a mixed box and asserts uniqueness.

- **publish: blob first, index second.** The manifest must never advertise bytes
  that are absent.
- **delete: index first, blob second.** The mirror image.
- **GC last, never fatally.** This is also what drops a superseded primary's
  bytes. A failed index write reports `published:false` and leaves the orphaned
  blob in place *deliberately* — same reasoning as books. Find any that
  accumulate with
  `npx wrangler kv key list --binding MAILBOX_KV --prefix 'box:<id>:wallpaper'`.

A stored entry is re-validated on **read** and dropped unless the id, the target
*and* the filename all round-trip through their validators unchanged — so a
corrupted value can never emit a forged line, an off-contract target, or a
`primary` carrying a name. A corrupt or unreadable index degrades to **nothing
pending** (a normal wake), never a 500.

`stat`/`getRange` apply here exactly as
[they do for books](#statgetrange-the-optional-half-of-the-store-contract), and a
test pins that both paths serve identical bytes for the same range.

---

## Deploy

Requires a Cloudflare account. `wrangler` is **not** a dependency of this repo —
install it ad hoc so the app's lockfile stays untouched:

```bash
cd mailbox

npx wrangler login                       # 1. auth (opens a browser)

npx wrangler kv namespace create MAILBOX_KV
# 2. prints:  id = "abc123…"  -> paste it into wrangler.jsonc kv_namespaces[0].id
#    (the placeholder is deliberately not a real id, so a deploy before this
#     step fails loudly instead of writing into someone else's namespace)

node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put WRITE_TOKEN      # 3. paste that value when prompted

npx wrangler deploy                      # 4. prints https://xteink-mailbox.<subdomain>.workers.dev
```

Then mint a box id and check it in the app:

```bash
node -e "import('./src/core.js').then(m => console.log(m.generateBoxId()))"
```

Verify the deploy before touching the reader:

```bash
BASE=https://xteink-mailbox.<subdomain>.workers.dev/m/<boxId>
TOKEN=<the WRITE_TOKEN>

head -c 52272 /dev/urandom > /tmp/frame.bin
curl -sS -X POST "$BASE/publish" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/octet-stream' -H 'X-Note-Id: deploy-check' \
  --data-binary @/tmp/frame.bin
curl -sS "$BASE/latest.txt"; echo
curl -sS "$BASE/current.frame" -o /tmp/out.bin && cmp /tmp/frame.bin /tmp/out.bin && echo IDENTICAL

# books, including the resume path the reader depends on
head -c 40000 /dev/urandom > /tmp/book.epub
curl -sS -X POST "$BASE/books" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Book-Id: deploy-check' -H 'X-Filename: Deploy Check.epub' \
  --data-binary @/tmp/book.epub
curl -sS "$BASE/books.txt"
curl -sS -r 16384- "$BASE/books/deploy-check" -o /tmp/tail.bin -D - | grep -i content-range
curl -sS -X DELETE "$BASE/books/deploy-check" -H "Authorization: Bearer $TOKEN"

# wallpapers: a primary, a set item, and the supersede rule
head -c 40000 /dev/urandom > /tmp/sleep.bmp
curl -sS -X POST "$BASE/wallpaper" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Wallpaper-Id: deploy-wp-1' -H 'X-Wallpaper-Target: primary' \
  --data-binary @/tmp/sleep.bmp
curl -sS -X POST "$BASE/wallpaper" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Wallpaper-Id: deploy-wp-2' -H 'X-Wallpaper-Target: set' \
  -H 'X-Filename: Deploy Check.bmp' --data-binary @/tmp/sleep.bmp
curl -sS "$BASE/wallpaper.txt"          # newest LAST; primary's filename field is "-"
curl -sS -r 16384- "$BASE/wallpaper/deploy-wp-1" -o /tmp/tail.bin -D - | grep -i content-range
curl -sS -X DELETE "$BASE/wallpaper/deploy-wp-1" -H "Authorization: Bearer $TOKEN"
curl -sS -X DELETE "$BASE/wallpaper/deploy-wp-2" -H "Authorization: Bearer $TOKEN"
```

**`wrangler dev` is not the same thing as the local dev server below** — it needs
auth and a real KV binding. Use `scripts/mailbox_dev_server.mjs` when offline.

---

## URL length budget — the constraint that actually bites

`crosspoint-reader` declares `char messageSyncUrl[128]`
(`src/CrossPointSettings.h`) and copies into it with
`strncpy(dest, src, maxLen - 1)` (`src/CrossPointSettings.cpp:25`). So:

> **the base URL must be ≤ 127 characters.** A 128th character is silently
> dropped, and the reader then polls a mangled URL that 404s forever, with no
> error surface anywhere except a serial log.

The app must enforce this at input time. `core.js` exports
`READER_URL_MAX_LEN` (127) and `checkReaderUrlBudget(url)` for that.

Fixed cost of `https://` + `/m/` + a 22-char box id = **33 chars**, leaving
**94 chars for the host**. On `workers.dev`, `xteink-mailbox.` + `.workers.dev`
costs 27, so the account subdomain may be up to **67 chars** — always fits.

| base URL | chars |
|---|---|
| `https://xteink-mailbox.<22-char-subdomain>.workers.dev/m/<22-char-box>` | 82 |
| `https://mail.example.com/m/<22-char-box>` | 49 |
| `http://192.168.0.168:8793/m/<22-char-box>` (dev server) | 50 |

Plenty of slack — but do not spend it on a longer box id *and* a custom
subdomain without re-running the arithmetic.

---

## Security model

**Reads are protected by the URL and nothing else.** The firmware sends no auth
headers on either GET (`MessageSync.cpp` calls `HttpDownloader` with empty
credentials, and `setInsecure()` accepts any certificate), so the `boxId` **is**
the read capability. It is 128 bits of CSPRNG entropy and never guessable, but
treat the base URL like a password:

- it is stored in the reader's settings in clear, and is readable from the
  reader's own web UI (`GET /api/settings`) by anyone on that LAN;
- **it is the read capability for the books and the wallpapers too.** Anyone with
  the URL can list `books.txt` / `wallpaper.txt` and download every epub and every
  pending sleep screen in the box, so treat a shared base URL as sharing the
  library and the imagery, not just the current note;
- to revoke, mint a new box id and re-provision the reader. An old box costs at
  most three note KV keys plus two manifests, up to `MAX_BOOKS` epub blobs and up
  to `MAX_WALLPAPERS` BMP blobs; list and delete them with
  `npx wrangler kv key list --binding MAILBOX_KV --prefix 'box:<id>:'` then
  `npx wrangler kv key delete --binding MAILBOX_KV '<key>'` for each. (The frame
  keys carry the note id, so the prefix listing is the reliable way to find
  them.)

**Writes need the bearer token.** `WRITE_TOKEN` is a single global secret shared
by every box:

- it is stored **separately from `mailboxUrl`** in app settings and must never
  be embedded in the URL the reader receives — the reader would then hand a
  write credential to anything that reads its settings;
- comparison is length-independent (no early exit on a matching prefix);
- a missing or <16-char token makes every authenticated route return **503, not
  200**. A blank secret must never mean "anyone may publish", which would turn
  the box id into a write capability too.

Because a valid token can publish to *any* box id, a compromised token is a
full compromise; rotate with `npx wrangler secret put WRITE_TOKEN`.

The Worker has no CORS headers — the client is a React Native app, which is not
subject to CORS. Add them only if a browser client ever appears.

### Known limitation: KV consistency is a DELAY, not a torn read

Workers KV is eventually consistent, its reads are edge-cached (60 s floor) and
its writes replicate **per key**. There is no cross-key ordering or atomicity,
and the frame-before-pointer write order constrains only the origin, never a
replica.

That is why the frame key is content-addressed. With a single mutable
`box:{id}:frame` slot, a colo could hold the **newest** `:meta` next to a
**60-second-old** `:frame`, and the reader — which pairs the two across two
separate HTTP requests and then dedups on the id — would stage note X's pixels
under note Y's id. The stale frame is still exactly 52272 bytes, so the
firmware's size check passes; it renders X, sets `messageLastShownId = Y`, and
from then on `latest.txt == Y == messageLastShownId`, so the frame is **never
re-fetched**. Note Y's image would be permanently lost, with the app reporting
success and nothing on either side able to detect it.

Deriving the frame key from the id removes that outcome: an unreplicated frame
can only **404**, which the firmware already handles by logging and retrying at
the next sleep, and a lagging pointer serves a consistent *old* pair. What is
left is pure delay — a publish can take up to ~60 s to be visible everywhere, so
"publish, then immediately put the reader to sleep" can miss by one cycle. That
is inside this system's tolerance (the reader syncs at deep-sleep **entry** and
renders at the **next wake**). Lowering `cacheTtl` below 60 does not help; KV
will not honour it.

**One race is left and it is not fixable here.** If a publish lands strictly
*between* the reader's two GETs, the reader read id X and downloads Y's bytes.
It renders Y, records X as shown, then at the next sync sees `latest.txt = Y ≠
X`, re-downloads and renders Y again — so X is skipped and Y is shown twice.
Self-correcting, unlike the case above. Closing it would need the reader to name
the id in its frame request, and the firmware fetches a fixed `/current.frame`
URL, so it is a property of the wire contract. Pinned by a test.

If sub-second freshness ever matters, the fix is a Durable Object, not a KV
tweak.

### Firmware TLS: a self-signed HTTPS origin is fine

There is **no CA-bundle requirement to design around**. `platformio.ini:41` puts
`-DFREEINK_NET_WOLFSSL=1` in the shared `[base] build_flags`, and every single
`[env:*]` (`default`, `gh_release`, `gh_release_rc`, `slim`, `sticky`) expands
`${base.build_flags}` — so every shipping build compiles `runGetWolf`, which
calls `http.setInsecure()` (`src/network/HttpDownloader.cpp:56`) and accepts any
certificate. The `config.crt_bundle_attach = esp_crt_bundle_attach` branch at
`HttpDownloader.cpp:131` sits behind `#if !defined(FREEINK_NET_WOLFSSL)` and is
dead code in all five envs.

Two body-framing assumptions, verified in
`freeink-sdk/libs/network/SecureNet/include/SecureHttpClient.h`:

- **A 200 with `Content-Length: 0` is COMPLETE.** `readFixed(c, 0, …)` never
  enters its loop and returns `true`, so `_bodyComplete` is set and
  `responseComplete()` passes. The empty-box `latest.txt` answer is a clean
  "mailbox empty", not a logged error every wake.
- **A chunked body is handled.** `readChunked` decodes chunk sizes, stops at the
  zero-size chunk and drains trailers, so `current.frame` may be sent chunked —
  which matters because the Worker lets the runtime frame the response.

(An `identity` body with *no* `Content-Length` falls back to `readUntilClose`,
which is also fine; both adapters here always set one.)

---

## Local dev server (no Cloudflare account)

The reader speaks plain HTTP happily (`HttpDownloader` picks the transport from
the URL scheme), so a LAN mailbox is a valid `messageSyncUrl`.

```bash
node scripts/mailbox_dev_server.mjs --port 8790            # generates + prints box id and token

# supervised / long-lived: token from the environment, one interface, on disk
MAILBOX_WRITE_TOKEN=<t> node scripts/mailbox_dev_server.mjs \
  --port 8790 --host 100.x.y.z --box <id> --data-dir ~/.xteink-mailbox --ttl 0
```

It prints the exact URL to provision and its length against the 127 budget.

For anything longer-lived than a smoke test:

- **pass the token in `$MAILBOX_WRITE_TOKEN`, not `--token`.** An argv token is
  world-readable in `ps` for the whole life of the process. Only a *generated*
  token is echoed in the startup banner; a supplied one never is, so a
  systemd `EnvironmentFile` keeps it out of both `ps` and the journal.
- **bind `--host` to the one interface that needs it** (the LAN or tailnet
  address), not the default `0.0.0.0`.
- **always pair `--ttl 0` with `--data-dir`.** In-memory is the default, and a
  restart silently drops the staged note.

Bounds — this repo has stalled its host with unbounded node processes before:
request bodies capped **per route** (64 KB for the note routes, `MAX_BOOK_BYTES`
for `POST /books`, `MAX_WALLPAPER_BYTES` for `POST /wallpaper`, chosen by
`core.js`'s `requestBodyLimit`; bytes past the cap
are discarded as they arrive and the request is answered **413** with
`Connection: close`, so a client learns why), exactly one box id served (so no
number of published ids widens it), single process, bounded
header/request/keep-alive timeouts, and a `--ttl` self-terminate (default
1800 s, max 86400). `--ttl 0` disables **only** the self-terminate, for runs
under a supervisor that owns the lifetime.

`--data-dir` writes each value to a temp file and `rename()`s it into place, so a
torn write can never leave a half-frame readable and the frame-then-pointer
ordering survives a crash.

> **Prefer `--data-dir` once books or wallpapers are in play.** The file store
> reads a **range** straight off the disk, so resuming a 24 MB epub (or a 1.1 MB
> BMP) costs the window asked for, not the whole file. The in-memory store keeps
> every blob resident, so its worst case is `MAX_BOOKS` x `MAX_BOOK_BYTES`
> (20 x 24 MB) plus `MAX_WALLPAPERS` x `MAX_WALLPAPER_BYTES` (8 x 4 MB) plus a
> frame — and the devbox systemd unit sets `MemoryMax=256M`, which is enough for
> one upload at a time but not for a resident library.

## Tests

`scripts/mailbox-core.test.js` runs inside `npm run ci` (the runner globs
`scripts/*.test.js`). Single file, bounded:

```bash
NODE_OPTIONS=--max-old-space-size=512 timeout 60 \
  node --import tsx --test scripts/mailbox-core.test.js
```

Never run the full suite locally — see `HANDOFF.md`.

## Notes

- `mailbox/package.json` sets `"type": "module"`. This is load-bearing: the repo
  root has no `type`, so without it node parses `src/*.js` as CommonJS and the
  dev server dies on the first `export`. It is not part of the app's dependency
  tree and the root `npm ci` never installs it.
- Nothing in `mailbox/` is imported by the React Native app, so it adds zero
  bytes to the APK.
