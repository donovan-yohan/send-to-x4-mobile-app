# Lovenote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**A note you send becomes the face of their sleeping book — then politely leaves.**

Two people, two phones, one e-ink reader. You write a note, doodle something, or pick a
photo. It travels to the reader. The next time your person sets the book down, *that* is
what the panel shows. Pick it up again and you are back on your page. Set it down once
more and the normal wallpaper is back.

A note gets exactly one sleep. There is no banner, no badge, no "you have 1 unread". The
reader never lights up at anyone. It just quietly wears the note for a while.

The same pipe also carries epubs and sleep-screen wallpapers.

> This is a fork of [Send to X4](https://github.com/Xatpy/send-to-x4-mobile-app) by
> Chapiware, reshaped from a read-it-later utility into a two-person messenger. It pairs
> with a matching firmware fork — see [The other half](#the-other-half-firmware).

> **Disclaimer:** independent and community-developed. Not affiliated with or endorsed by
> Xteink. "Xteink", "X3" and "X4" are trademarks of their respective owners.

---

## How a note actually gets there

The reader is a battery-powered e-ink device that spends almost all of its life in deep
sleep with its radio off. While it is asleep it is invisible on the network — nothing can
push to it, so something has to sit in the middle and wait. The app has three ways to get
bytes across and picks the best one available at send time.

```
 PHONE (Lovenote)                                          READER (CrossPoint firmware)
 ================                                          ============================

   compose ──┬─ 1. DIRECT ──────────────────────────────▶  HTTP :80  + WebSocket :81
             │     same Wi-Fi, reader awake                 frame written straight to SD
             │     instant, no server involved
             │
             │                    ┌───────────────┐
             ├─ 2. MAILBOX ──────▶│    mailbox    │◀────── GET latest.txt / current.frame
             │     POST /publish  │ capability URL│        GET books.txt   / books/{id}
             │     (bearer token) │  Worker  -or- │        GET wallpaper.txt / wallpaper/{id}
             │     from anywhere  │ your own node │
             │                    └───────────────┘        the reader PULLS, on its own
             │                                             sync windows. Nothing is
             │                                             pushed at a sleeping device.
             │
             └─ 3. PEER LINK ─── reader raises its OWN AP (192.168.4.0/24, the ESP32
                   "Sync with App"  default). Phone joins as a peer, keeps cellular as its
                                    default route, and answers the SAME /m/* paths on
                                    :8080 — forwarding to the mailbox over cellular, or
                                    serving from its own on-disk outbox with zero internet.
```

Three transports, **one protocol**. Routes 2 and 3 speak byte-identical requests; the peer
link is just a different base URL, so nothing about staging, dedup or resume changes.

**When the reader syncs (route 2):** at deep-sleep entry, on a silent background check
after a wake, and on demand from the reader's own **Mailbox Sync** menu entry
(Home → File Transfer). Route 3 is **Sync with App** in the same menu.

**What lands:** a note is a single latest-wins 1-bit frame for the 792 x 528 panel
(52,272 bytes exactly). Books are a *set* — up to 20 epubs, each independently
present-or-absent on the reader and each resumable across windows via HTTP `Range`.
Wallpapers are a small set too (up to 8 pending).

**Roles.** Each install is a **host** or a **client** (`Settings -> This Device`).

- **Host** — paired with the reader over Wi-Fi, owns permanent device state. Only the host
  sees the Wallpaper and Library tabs.
- **Client** — the partner. No direct reader access; sends through the mailbox or hands
  items over on the peer link.

The gate is `isHost()` in `src/services/role.ts`, pinned by `scripts/role.test.js`.

---

## Quick start

Read **[docs/SETUP.md](./docs/SETUP.md)** — it walks the whole path end to end: install the
app, stand up a mailbox, provision the reader, pair a partner. Don't try to assemble it
from this file; the setup guide is the one that has been checked against a real device.

If you only want to *use* it, you need three things:

1. the app on both phones (below),
2. the [firmware fork](#the-other-half-firmware) on the reader,
3. a mailbox — either a Cloudflare Worker (`mailbox/README.md` § Deploy) or a plain node
   process on any always-on machine (`scripts/mailbox_dev_server.mjs`).

Only route 1 works with no mailbox at all. **Route 3 needs a mailbox URL configured even
though it needs no internet**: `isHandoverAvailable` gates the button on a base URL
carrying an `/m/<box-id>` path, because that path is what the phone answers to the reader
over the AP — it just does not have to be *reachable* in local-serve mode. Route 2 is what
makes "send from anywhere" true. Skipping the mailbox costs you routes 2 and 3 and any
client-role phone; `docs/SETUP.md` § 3(c) spells out that trade.

---

## Install the app

Android APKs are published on the
[Releases page](https://github.com/donovan-yohan/send-to-x4-mobile-app/releases).
Download the `.apk` from the newest release and sideload it (you will have to allow
installs from your browser/file manager the first time).

No iOS build ships. `modules/reader-link` declares `"platforms": ["android"]`, so the peer
link (route 3) exists on Android only; routes 1 and 2 are plain JS and would work anywhere.
`src/services/reader_link.ts` resolves the native half by name with
`requireOptionalNativeModule` and exposes `isAvailable()`, so the bundle keeps loading
where the Kotlin does not exist — an iOS build from source would run, just without "Sync
with App".

---

## Development

Requirements: **Node 20.x** (`.nvmrc`, and `engines` in `package.json` pins `>=20 <21`).
Newer majors can fail on tooling transforms outside the app runtime. For a native build you
also need Android Studio with SDK 36+.

```bash
# -b messenger is REQUIRED. The repository's default branch is `main`, which is
# the unmodified upstream Send to X4 — it has no mailbox/, no messenger work.
git clone -b messenger https://github.com/donovan-yohan/send-to-x4-mobile-app.git
cd send-to-x4-mobile-app

nvm use            # Node 20
npm ci             # exact lockfile install

cp .env.example .env          # fill in your own bundle id / app group / EAS project id
npx expo prebuild --clean     # regenerate android/ from YOUR identifiers
npx expo run:android
```

`android/` is **prebuild output and is gitignored** — `npx expo prebuild` generates it from
`app.config.ts` + `.env`. Regenerate it after editing `.env` so your identifiers, app group
and signing settings are applied consistently, and remember that anything you hand-edit
inside `android/` is lost on the next `--clean` regeneration; persist it in `app.json` or a
config plugin instead.

### Tests

```bash
npm run typecheck    # tsc --noEmit — the only type gate; the test runner is transpile-only
npm run test:all     # node --test over scripts/*.test.js, via scripts/run-tests.mjs
npm run ci           # typecheck + tests on a REMOTE host (see below)
```

Tests are Node's built-in runner with `tsx` as the TypeScript loader, importing `src/**/*.ts`
directly — no bundler, no React Native mocking. Drop a new `scripts/*.test.js` in and the
glob picks it up; no config change needed.

**Two things in the harness will look strange until you know why.**

*`npm run test:all` can refuse to run.* `scripts/run-tests.mjs` keeps a `BLOCKED_HOSTS`
list and exits **2** without running if `os.hostname()` matches. That list exists because
unbounded `node --test` workers once ate ~20 GiB and stalled one specific development box.
Unless your machine happens to share that hostname, `test:all` just runs. If you ever add a
host to the list, `ALLOW_LOCAL_TESTS=1` is the deliberate override. The bounds that survive everywhere are
the real point: the suite runs **serially** (`--test-concurrency=1`), under a **3 GB heap
cap**, with a **10-minute wall clock** that SIGKILLs the whole process group. Exit codes
are a contract: `0` pass, `1` fail, `2` refused, `124` timed out.

*`npm run ci` is not GitHub Actions.* It is `scripts/ci-remote.sh`: rsync the working tree
to another machine over SSH, `npm ci` there only when the lockfile or Node version changed,
then `tsc --noEmit` and the full suite with the bounds above. It exists so a laptop or a
shared devbox is never the thing running the whole suite. Point it at your own machine with
environment variables — `CI_HOST`, `CI_DEST`, `CI_TIMEOUT` (default 1200s),
`CI_HEAP_MB` — or ignore it entirely and run `npm run typecheck && npm run test:all`
locally. Two behaviours worth knowing if you do use it: it **refuses** (exit 96) when the
remote host's Node major is not the one `.nvmrc` declares, and it carries the remote exit
status **in-band** on a nonce-tagged line, because the SSH server it was built against
reports `exit-status 0` no matter what the remote command returned. Both have long
explanations in the script header; neither is decoration.

Contributor-facing CI (`.github/workflows/ci.yml`) runs `npm ci` + `npm run typecheck` +
`npm run test:all` on a GitHub runner, whose hostname is not blocked.

### The mailbox, locally

```bash
node scripts/mailbox_dev_server.mjs --help
node scripts/mailbox_dev_server.mjs --port 8790 --data-dir ./mailbox-data
```

Same `mailbox/src/core.js` the Cloudflare Worker runs, wrapped in a node HTTP server. A
missing token or box id is generated and printed. Every request body is capped per route,
bearer auth is checked *before* buffering on the expensive routes, it serves exactly one
box id, and it self-terminates after `--ttl` seconds (default 1800). Prefer `--data-dir`
once books or wallpapers are involved — the in-memory store keeps every blob resident.

---

## What lives in this repo

| Path | What it is |
|---|---|
| `App.tsx` | Entry point: tab + stack navigation, share-intent routing, role gating |
| `src/screens/` | Compose, History, Wallpaper, Device (labelled "Library"), Settings |
| `src/services/` | Transports, encoders, senders, mailbox client, outbox, settings, role |
| `src/device/x3.ts` | Panel geometry and frame constants (792 x 528, 52,272-byte frame) |
| `src/components/`, `src/theme/` | UI primitives, design tokens |
| `mailbox/src/core.js` | The **entire** wire contract — platform-free, zero imports |
| `mailbox/src/worker.js` | Cloudflare glue: KV -> store, `env.WRITE_TOKEN` -> config |
| `mailbox/wrangler.jsonc` | Worker deploy config (two placeholders you must fill) |
| `mailbox/README.md` | Operator-facing mailbox docs: deploy, caps, verification curls |
| `scripts/mailbox_dev_server.mjs` | Self-host node server over the same `core.js` |
| `scripts/*.test.js` | The suite. One file per module; `run-tests.mjs` globs them |
| `scripts/ci-remote.sh` | The bounded remote test harness described above |
| `modules/reader-link/` | Local Expo module (Android/Kotlin): peer AP join + read-only proxy |
| `docs/xteink/` | Wire contracts and design docs — the sources of truth |
| `plugins/` | Custom Expo config plugins |

`core.js` is shared on purpose: a behaviour proven by `scripts/mailbox-core.test.js` holds
on both the Worker and the local server, because neither adapter contains a routing,
validation or ordering decision of its own.

`modules/reader-link` is a **local** Expo module, not an npm package — autolinking finds it
because `expo-modules-autolinking` defaults `nativeModulesDir` to `./modules`. It is
Android-only and resolved with `requireOptionalNativeModule`, so the JS bundle still loads
in a dev client that predates it.

---

## Features

- **Compose** — text, doodle, or a photo, rendered to a panel-true e-ink preview before it
  goes. Portrait or landscape.
- **Three routes, chosen for you** — the app picks direct / mailbox / handover based on what
  it can actually reach, and says which one it used rather than promising delivery it can't
  make (`src/services/deliverability.ts`).
- **Share sheet** — share text or an image from any app; it routes into Compose.
- **Library** — send epubs to the reader, over LAN or queued through the mailbox; browse and
  delete files on the device.
- **Wallpaper** — set the reader's permanent sleep screen; promote a past note to it.
- **History** — outbox and message log with per-item delivery state.
- **Offline handover** — the peer link serves queued notes and books from the phone's own
  disk when there is no internet at all.
- **Wi-Fi handover** — hand the reader a network's credentials over the peer link, on a
  local-only endpoint the reader acks with a `DELETE`.

---

## Security model

Three secrets, three jobs. Nothing else guards anything.

- **The capability URL is the read secret.** A mailbox lives at `{origin}/m/{boxId}`, where
  `boxId` is 22–64 url-safe characters drawn from 128 bits of CSPRNG entropy. Reads
  (`latest.txt`, `current.frame`, `books.txt`, `books/{id}`, `wallpaper*`) are
  **unauthenticated** — the unguessable path *is* the credential, because the reader has no
  good place to keep one. Treat the whole URL as a password: whoever has it can read every
  note in that box.
- **The bearer token is the write secret.** Every publish and delete
  (`POST /publish|/books|/wallpaper`, `DELETE /books/{id}`) requires
  `Authorization: Bearer <write-token>`. It never leaves the phone and the mailbox server —
  in particular the peer-link proxy is a strictly read-only forwarder for `GET`/`HEAD` on
  `/m/*`, refuses every other method and path, and has no parameter that could carry an
  `Authorization` header. That is enforced in Kotlin and pinned by
  `scripts/reader-link-contract.test.js`.
- **The reader's AP passphrase guards the peer link.** During "Sync with App" the reader
  raises its own access point and — deliberately — does **not** start its web server: no
  HTTP on `:80`, no WebSocket on `:81`, no upload/delete/rename handlers. It is a pure
  client on its own AP. Set a passphrase on the reader (**Settings → System → Sync with App
  passphrase**, stored as `mailboxApPsk`) and type the same value into
  `Settings -> Reader AP password` in the app; an empty value means the open AP the firmware
  ships with, which is fine on your own couch and not much else.

No analytics, no tracking SDKs, no account. Notes are rendered on the phone and, on routes
1 and 3, never touch a server at all. On route 2 they sit in your mailbox — which you
deployed and control — until the reader collects them.

Vulnerability reports: see [SECURITY.md](./SECURITY.md).

---

## The other half (firmware)

The reader runs a fork of [CrossPoint](https://github.com/crosspoint-reader/crosspoint-reader),
a community firmware for the Xteink X3 (PlatformIO / ESP32-C3):

**[donovan-yohan/crosspoint-reader](https://github.com/donovan-yohan/crosspoint-reader)** — branch `develop`

It adds the sleep-screen note model, the mailbox pull client, and the two network modes
(**Mailbox Sync**, **Sync with App**), plus the **Message Sync** master toggle and the
**Sync with App passphrase** under the reader's Settings → System.

### Wire contracts

If you are implementing against this — another client, another firmware, your own
mailbox — these are the authorities, not this README:

- **[docs/xteink/mailbox-books-contract.md](./docs/xteink/mailbox-books-contract.md)** —
  the full wire contract. §2 notes and books, §2W wallpaper, §3A the lock-screen note
  model, Appendix A3 the peer link (`/cp-proxy`, `/cp-wifi`).
- **[mailbox/README.md](./mailbox/README.md)** — operator view: deploy, storage layout,
  caps, publish ordering, the URL-length budget the reader's 127-char field imposes.
- `mailbox/src/core.js` — where the contract is actually true.

---

## Contributing

Bug reports, ideas and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Please run `npm run typecheck` and the test
suite before opening a PR, and keep changes to `mailbox/src/core.js` accompanied by
assertions in `scripts/mailbox-core.test.js` — it is the only thing standing between a
routing change and a reader that silently stops syncing.

---

## License and attribution

MIT — see [LICENSE](./LICENSE).

Copyright (c) 2026 Chapiware. This fork retains the upstream copyright and license;
third-party attributions are in [NOTICE](./NOTICE).

- Upstream app: [Xatpy/send-to-x4-mobile-app](https://github.com/Xatpy/send-to-x4-mobile-app)
  (MIT) — [chapiware.com/send-to-x4](https://chapiware.com/send-to-x4)
- Upstream firmware: [crosspoint-reader/crosspoint-reader](https://github.com/crosspoint-reader/crosspoint-reader)
