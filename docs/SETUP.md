# Setup — end to end

This is the guide for someone who has none of it yet: no firmware, no server, no app.
Follow it in order and you end up with a two-person love-note messenger that writes to
an e-ink reader.

**What the system is.** One phone composes a note (photo, text, or a doodle). The note
reaches the reader, and at the reader's *next sleep* the note **is** the sleep screen —
for exactly one sleep. Then the configured wallpaper comes back. The same pipe also
delivers epubs and wallpapers. Nobody has to wake the reader, tap anything on it, or be
on the same network.

**Two repositories, one system.**

| | repo | branch |
|---|---|---|
| Phone app ("Lovenote"), mailbox server, docs | `donovan-yohan/send-to-x4-mobile-app` | `messenger` |
| Reader firmware (CrossPoint fork) | `donovan-yohan/crosspoint-reader` | `develop` |

Both are public forks. The app is a fork of [`Xatpy/send-to-x4-mobile-app`](https://github.com/Xatpy/send-to-x4-mobile-app)
(MIT — see [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE)); the firmware is a fork of
[`crosspoint-reader/crosspoint-reader`](https://github.com/crosspoint-reader/crosspoint-reader).
Neither is affiliated with or endorsed by Xteink.

**The three routes a note can take.** You do not choose one; the app picks per send, and
the reader collects on its own schedule.

| route | when it engages | needs |
|---|---|---|
| **Direct** | the reader is awake on the same LAN right now | nothing but the LAN |
| **Mailbox** | always, once configured — the reader pulls on its own sync windows | a mailbox server (§3) |
| **Peer link** ("Sync with App") | you and the reader are in the same room and you run it deliberately | phone + reader, no internet required |

Direct is rare in practice: the reader spends almost all its life in deep sleep with the
radio off, so it is invisible on the network. The mailbox is what makes "send from
anywhere" work. The peer link is the escape hatch for no-internet.

> **Every URL, id, token and IP in this document is a placeholder.** Substitute your own.
> `https://mailbox.example.com/m/<box-id>`, `<write-token>`, `192.168.x.y`.

---

## 1. What you need

### The reader — an Xteink X3

**The X3 is what is proven.** The panel contract was nailed on physical X3 hardware:
792×528 native landscape, 1-bit, and a love-note frame is **exactly 52,272 bytes**
(528 rows × 99 bytes/row). The mailbox rejects any other size on the *write* path, and the
firmware silently discards a wrong-sized frame on the read path, so the number is enforced
on both ends.

**About the X4.** CrossPoint itself runs on both: the ESP32-C3 build is a single
dual-target binary (`-DFREEINK_DEVICE_X3=1 -DFREEINK_DEVICE_X4=1` in every C3 `[env:*]` —
`default`, `gh_release`, `gh_release_rc`, `slim`) that detects the panel at runtime.
(`[env:sticky]` is a different MCU family entirely, ESP32-S3, and is not part of this.)
But the parts *this* fork adds are X3-shaped:

- **Note frames are X3 geometry only.** The app composes 528×792 portrait and maps it into
  the 792×528 landscape buffer with a 90° counter-clockwise rotation. The X4 panel is
  480×800 — a different size *and* a different bit depth (the upstream app's encoder
  targeted 480×800 24-bit BMP). Sending an X3 frame to an X4 does not "look rotated", it is
  refused by the size check. Making notes work on an X4 is a new encoder plus a new frame
  size agreed on both sides.
- **Panel and power paths diverge.** The differential/half-refresh path, tilt page turn, and
  a branch in the power manager are all gated on `deviceIsX3()`.

Books and wallpapers ride generic paths and are much more likely to be fine on an X4.
Notes — the whole point — are not. Details in
[`docs/xteink/crosspoint-firmware-assessment.md`](xteink/crosspoint-firmware-assessment.md)
and [`docs/xteink/app-fork-plan.md`](xteink/app-fork-plan.md).

### The phone — Android

**iOS is not supported, and this is structural rather than a to-do.** The peer link is a
native module (`modules/reader-link/`) whose `expo-module.config.json` declares
`"platforms": ["android"]` and which has no iOS source at all. It exists because Android's
`WifiNetworkSpecifier` can join the reader's access point *while keeping cellular as the
default route* — that is exactly what lets the phone sit on the reader's AP and still
proxy the mailbox over the internet. iOS has no app-level equivalent. Direct and mailbox
sends are not conceptually iOS-hostile, but nothing in this fork is built or tested for
iOS, and the peer link cannot be ported as-is.

You need one phone per person. Both can be the same model; they take different roles (§5).

### A computer for flashing

USB-C cable that carries **data** (a charge-only cable is the classic first hour lost).
Any OS that runs PlatformIO. You only need this once.

> **Check whether your unit is USB-locked before you buy a cable.** Some Xteink units from
> third-party stores ship with USB flashing locked at the factory. Upstream documents the
> unlocker and a serious bricking warning — read
> [the firmware README's "USB-locked devices" section](https://github.com/crosspoint-reader/crosspoint-reader#usb-locked-devices-xteink-unlocker)
> before touching it. Units bought direct from xteink.com are not locked.

### Optional but strongly recommended — somewhere to host the mailbox

Either a **free Cloudflare account**, or a **small always-on machine** (a Pi, a NAS, a VPS,
an old laptop) plus a way to expose one HTTPS or HTTP path to it. §3 covers both, and the
third option of doing without.

---

## 2. Flash the firmware

```bash
git clone --recursive -b develop https://github.com/donovan-yohan/crosspoint-reader
cd crosspoint-reader
```

**If you cloned without `--recursive`, do this now:**

```bash
git submodule update --init --recursive
```

> **A stale or missing submodule is the single most confusing build failure here.** The
> firmware pulls its display, network and UI layers in as submodules, so what you get is
> not "submodule missing" — it is a wall of *missing header* errors from files you never
> edited, pointing at paths that look like they should exist. If `pio run` explodes on
> includes, run the `git submodule update --init --recursive` above before debugging
> anything else. Same after any `git pull` that moved a submodule pointer.

**Prerequisites** (from upstream): [pioarduino](https://github.com/pioarduino/pioarduino)
or VS Code + the pioarduino plugin, Python 3.8+, and that data-carrying USB-C cable. Nix
users: `nix develop -f nix` or `nix-shell nix`.

**Build and flash:**

```bash
pio run -e default              # compile only — do this first, it is the cheap failure
pio run --target upload         # compile + flash the connected device
```

`-e default` is the right target for an X3. There is no separate `-e x3` env; as noted
above the C3 environments build one binary for both panels.

On Linux you may need udev rules for the ESP32-C3 to appear. NixOS:

```nix
services.udev.packages = with pkgs; [ platformio-core.udev ];
```

**Alternative: no toolchain at all.** If you would rather not build, upstream ships a web
flasher and prebuilt `firmware.bin` releases — but note those are *upstream* CrossPoint and
do **not** contain the messenger work (mailbox sync, the display-once note model, the peer
link). For this system you want a build from the `develop` branch of the fork above.

### First-boot sanity check

1. The reader boots to the CrossPoint home screen.
2. On serial you should see `MAIN Hardware detect: X3`.
3. **Home → File Transfer** opens a five-item menu, in this order: *Join a Network*,
   *Calibre Wireless*, *Create Hotspot*, **Mailbox Sync**, **Sync with App**. The last two
   are the messenger additions — if they are not there, you flashed the wrong branch or the
   wrong binary.
4. **Settings → System** contains **Message Sync** (a toggle) and **Sync with App
   passphrase** (the first row of that category). Same check.

To watch serial while you work, upstream ships a monitor:

```bash
python3 -m pip install pyserial colorama matplotlib
python3 scripts/debugging_monitor.py            # add /dev/cu.usbmodemXXXX on macOS
```

Keep that terminal. §7 is mostly "read the serial breadcrumbs".

---

## 3. Host the mailbox

**This is the section that decides what your system can do.** The mailbox is a tiny
capability-URL server that holds *one* pending note frame, up to 20 epubs and up to 8
pending sleep screens per box. The reader pulls from it; the phone publishes to it. It
exists because the reader is invisible on the network while asleep, so something durable
has to sit in the middle.

The wire contract is small and fully specified in
[`docs/xteink/mailbox-books-contract.md`](xteink/mailbox-books-contract.md); the server
itself is [`mailbox/`](../mailbox/README.md). One file, `mailbox/src/core.js`, *is* the
contract — the Cloudflare Worker and the self-host server are both thin adapters over it,
so a behaviour proven by the tests holds identically on either.

There are three options. Pick honestly.

| | works from anywhere | you run infrastructure | client (partner) phone can send | peer link available |
|---|---|---|---|---|
| **(a) Cloudflare Worker** | yes | no | yes | yes |
| **(b) Self-host** | yes, if you expose it | yes | yes | yes |
| **(c) No mailbox** | no | no | **no** | **no** |

### First: mint a box id and a write token

Both options (a) and (b) need these two values, and they are *different kinds of secret*.

- **Box id** — 22 url-safe characters, 16 CSPRNG bytes = 128 bits. It sits in the URL path
  (`/m/<box-id>`) and **it is the read capability**. There is no other protection on reads.
- **Write token** — 43 url-safe characters, 32 CSPRNG bytes. Sent as
  `Authorization: Bearer <write-token>`. It is global to the deployment: a valid token can
  publish to *any* box id on that server. It must **never** appear in the URL.

From a checkout of the app repo:

```bash
node -e "import('./mailbox/src/core.js').then(m => console.log('box  ', m.generateBoxId()))"
node -e "import('./mailbox/src/core.js').then(m => console.log('token', m.generateWriteToken()))"
```

(`generateBoxId` / `generateWriteToken` are in `mailbox/src/core.js`. The self-host server
in option (b) generates and prints both for you if you do not supply them.)

### The 127-character ceiling — do this arithmetic before you pick a hostname

The reader stores the mailbox base URL in `char messageSyncUrl[128]` and copies into it
with `strncpy(dest, src, maxLen - 1)`. So:

> **The base URL must be ≤ 127 characters.** A 128th character is silently dropped. The
> reader then polls a mangled URL that 404s forever, with no error surface anywhere except
> the serial log.

The arithmetic, for an HTTPS origin and a standard 22-char box id:

```
  https://   →   8
  /m/        →   3
  <box-id>   →  22
  ───────────────
  fixed cost →  33     leaving 127 − 33 = 94 characters for the host
```

Plain `http://` buys you one more character. Representative shapes:

| base URL shape | chars |
|---|---|
| `https://<worker-name>.<22-char-subdomain>.workers.dev/m/<22-char-box>` | 82 |
| `https://mail.example.com/m/<22-char-box>` | 49 |
| `http://192.168.x.y:8790/m/<22-char-box>` | ~49 |

Plenty of slack — but do not spend it on a longer box id *and* a long custom hostname
without re-running the count. `core.js` exports `READER_URL_MAX_LEN` (127) and
`checkReaderUrlBudget(url)`; the app enforces it at input time and the self-host server
prints your URL's length against the budget at startup.

---

### (a) Cloudflare Worker — the least work

Free tier is fine for two people. `wrangler` is deliberately **not** a dependency of this
repo, so install it ad hoc and leave the app's lockfile alone.

```bash
cd mailbox

npx wrangler login                              # 1. auth (opens a browser)

npx wrangler kv namespace create MAILBOX_KV     # 2. prints an id
#    Paste that id into wrangler.jsonc → kv_namespaces[0].id.
#    The checked-in placeholder is deliberately NOT a real id, so a deploy
#    before this step fails loudly instead of writing into someone else's namespace.

npx wrangler secret put WRITE_TOKEN             # 3. paste the write token you minted above
#    A SECRET, never a `vars` entry — a plaintext var would commit your write
#    credential to git.

npx wrangler deploy                             # 4. prints your workers.dev URL
```

Your base URL is then `https://<what-step-4-printed>/m/<box-id>`.

**Verify before you touch the reader** (placeholders throughout):

```bash
BASE=https://mailbox.example.com/m/<box-id>
TOKEN=<write-token>

head -c 52272 /dev/urandom > /tmp/frame.bin
curl -sS -X POST "$BASE/publish" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/octet-stream' -H 'X-Note-Id: deploy-check' \
  --data-binary @/tmp/frame.bin
curl -sS "$BASE/latest.txt"; echo                       # → deploy-check
curl -sS "$BASE/current.frame" -o /tmp/out.bin && cmp /tmp/frame.bin /tmp/out.bin && echo IDENTICAL
```

A fuller check including the books `Range`-resume path and the wallpaper supersede rule is
in [`mailbox/README.md` → Deploy](../mailbox/README.md#deploy). Run it; the resume path is
the one the reader actually depends on for anything book-sized.

**What Cloudflare's limits shape.** Workers KV caps a single *value* at 25 MiB, which is
why `MAX_BOOK_BYTES` is **24 MiB** — inside the ceiling, and roughly 5× the largest
realistic epub. A larger cap would let the app report a successful 200 for a book whose
`kv.put` then failed, i.e. a book the reader can never see. Related, and worth knowing
before you debug a "late" note: **KV is eventually consistent with a 60-second edge-cache
floor**, so publishing and *immediately* putting the reader to sleep can miss by one cycle.
That is delay, not corruption — the frame key is derived from the note id specifically so a
lagging replica can only 404 or serve a consistent *old* pair, never mismatched pixels.

> `wrangler dev` is **not** the same as the self-host server below — it wants auth and a
> real KV binding.

---

### (b) Self-host — `scripts/mailbox_dev_server.mjs`

The same `mailbox/src/core.js`, wrapped in a Node HTTP server. **Zero third-party
dependencies** — it imports only Node builtins and `core.js` — so a plain clone plus Node
20 is the whole install. No `npm ci` required for the mailbox alone.

```bash
git clone -b messenger https://github.com/donovan-yohan/send-to-x4-mobile-app
cd send-to-x4-mobile-app
node scripts/mailbox_dev_server.mjs --help
node scripts/mailbox_dev_server.mjs --port 8790     # generates + prints a box id and token
```

The startup banner prints the exact base URL to provision and its length against the
127-character budget.

**For anything longer-lived than a smoke test:**

```bash
MAILBOX_WRITE_TOKEN=<write-token> node scripts/mailbox_dev_server.mjs \
  --port 8790 --host <one-interface-address> --box <box-id> \
  --data-dir /var/lib/xteink-mailbox --ttl 0
```

Four rules, each of which exists because the alternative bit someone:

- **Token in `$MAILBOX_WRITE_TOKEN`, not `--token`.** An argv token is world-readable in
  `ps` for the life of the process. Only a *generated* token is echoed in the banner; a
  supplied one never is, so a systemd `EnvironmentFile` keeps it out of both `ps` and the
  journal.
- **`--host` binds one interface.** The default is `0.0.0.0`. Bind the LAN or overlay
  address that actually needs to answer, not every interface.
- **Always pair `--ttl 0` with `--data-dir`.** `--ttl 0` disables *only* the self-terminate
  timer, for runs under a supervisor that owns the lifetime. In-memory is the default, and
  a restart silently drops the staged note.
- **Prefer `--data-dir` once books or wallpapers are in play.** The file store reads a
  *range* straight off the disk, so resuming a 24 MB epub costs the window asked for. The
  in-memory store keeps every blob resident — worst case 20 × 24 MB of books plus
  8 × 4 MB of wallpapers plus a frame.

The file store writes each value to a temp file and `rename()`s it into place, so a torn
write can never leave a half-frame readable and the frame-then-pointer ordering survives a
crash.

**Boundedness is a designed property of this file**, not an accident: request bodies are
capped *per route* (64 KB for notes, `MAX_BOOK_BYTES` for `POST /books`,
`MAX_WALLPAPER_BYTES` for `POST /wallpaper`), the bearer token is checked *before* buffering
on any route whose cap exceeds the notes cap (so knowing the box id — a read capability,
cleartext by design — cannot make the process allocate 24 MB per request), exactly one box
id is served, it is single-process, and every phase of a connection is timeout-bounded.

#### Getting it reachable from outside

The reader speaks **plain HTTP happily** (`HttpDownloader` picks the transport from the URL
scheme), so `http://192.168.x.y:8790/m/<box-id>` is a perfectly valid `messageSyncUrl` — it
just means the reader only syncs when it is on that network.

To sync from anywhere, put one public path in front of the server. The pattern matters more
than the product; these are **examples**, not requirements:

- **Reverse proxy** (nginx, Caddy) on a box that already has a domain and a certificate.
  Proxy one path to `127.0.0.1:8790`.
- **A tunnel** (Cloudflare Tunnel, ngrok, and friends) if the machine has no inbound ports.
- **Tailscale Funnel** if you already run a tailnet — it publishes one service on an HTTPS
  hostname without opening a firewall.

Whatever you choose, the requirements are only these:

1. It is reachable from wherever the reader will sync (your home Wi-Fi, at minimum).
2. The resulting base URL fits in 127 characters (§ above).
3. HTTPS or plain HTTP both work. See the honest note in §8 about what the reader's HTTPS
   *does not* give you.

#### systemd unit template

Adapt paths and user. The memory caps are the point — this repo has stalled a host with
unbounded Node processes before.

```ini
# /etc/systemd/system/xteink-mailbox.service
[Unit]
Description=Xteink mailbox
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=xteink
Group=xteink
WorkingDirectory=/opt/send-to-x4-mobile-app

# The write token lives here, mode 0600, owned by root. Never in ExecStart:
# an argv token is world-readable in `ps`.
#   MAILBOX_WRITE_TOKEN=<write-token>
EnvironmentFile=/etc/xteink-mailbox.env

ExecStart=/usr/bin/node scripts/mailbox_dev_server.mjs \
    --port 8790 \
    --host 127.0.0.1 \
    --box <box-id> \
    --data-dir /var/lib/xteink-mailbox \
    --ttl 0 \
    --quiet

Restart=on-failure
RestartSec=5s

# Bounds. MemoryMax is enough for one upload at a time, not for a resident
# library — which is exactly why --data-dir above is not optional here.
MemoryMax=256M
TasksMax=32
LimitNOFILE=1024

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
StateDirectory=xteink-mailbox
ReadWritePaths=/var/lib/xteink-mailbox

[Install]
WantedBy=multi-user.target
```

```bash
sudo install -m 0600 /dev/null /etc/xteink-mailbox.env   # then write MAILBOX_WRITE_TOKEN=... into it
sudo systemctl enable --now xteink-mailbox
sudo systemctl status xteink-mailbox
```

`--host 127.0.0.1` above assumes a reverse proxy or tunnel on the same machine. If the
reader talks to it directly on the LAN, bind the LAN address instead.

> `mailbox/package.json` sets `"type": "module"`, and that is load-bearing: the repo root
> has no `type`, so without it Node parses `mailbox/src/*.js` as CommonJS and the server
> dies on the first `export`. Nothing in `mailbox/` is imported by the app, so it adds zero
> bytes to the APK.

---

### (c) No mailbox at all

Perfectly valid if you and the reader share a home and you never want a server. You are
left with **direct LAN pushes only**, and you should know exactly what that costs:

- **Sending from anywhere is gone.** The reader can only be written to while it is awake
  and on your LAN — which is a small fraction of its life, since deep sleep turns the radio
  off.
- **The reader's ambient sync does nothing.** Sleep-entry sync and the silent wake check
  both return immediately with `no mailbox URL configured`. There is nothing to poll.
- **A client-role phone cannot send at all.** Client is mailbox-only by design; it has no
  direct reader access.
- **The peer link is gone too.** `Sync with App` is gated on a mailbox base URL that has an
  `/m/<box-id>` path (`isHandoverAvailable` → `describeProxyTarget`), because that path is
  what the phone serves to the reader over the AP. No URL, no handover — the button is not
  offered.

If any of those matter, take option (a). It is a free Cloudflare account and about ten
minutes.

---

## 4. Install the app

### Option 1 — a release APK

Download the newest `.apk` from the app repo's
[Releases page](https://github.com/donovan-yohan/send-to-x4-mobile-app/releases) and
sideload it on both phones. Android will warn about an unknown source and ask you to allow
installs from your browser or file manager the first time; that is expected for a
two-person app that is not on Play.

### Option 2 — build from source

```bash
git clone -b messenger https://github.com/donovan-yohan/send-to-x4-mobile-app
cd send-to-x4-mobile-app

nvm use                 # Node 20 — pinned by .nvmrc and package.json engines
npm ci

cp .env.example .env    # then fill in APP_BUNDLE_ID, APP_IOS_APP_GROUP, EAS_PROJECT_ID
npx expo prebuild --clean

cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Notes that will save you an evening:

- **Node 20 is required, not suggested.** `.nvmrc` pins it, `engines` declares
  `>=20 <21`, and the CI script (`scripts/ci-remote.sh`) refuses to run on any other major
  rather than validating on a runtime the app does not ship on.
- **`.env` must exist before `prebuild`.** `app.config.ts` reads it at build time and only
  *warns* when values are missing — you get an app with example identifiers, not an error.
- **`android/` is prebuild output and is gitignored.** `expo prebuild --clean` regenerates
  it. Anything you hand-edit there (Gradle memory tuning, for instance) is lost on the next
  regeneration; to persist it, move it into `app.json` or a config plugin.
- **This is not Expo Go.** The peer link is a native module, so you need a real build.
- **The release APK is signed with the debug keystore.** Expo's prebuild wires
  `release { signingConfig signingConfigs.debug }` in `android/app/build.gradle`. That is
  fine for sideloading onto two phones you own — it is *not* suitable for distribution, and
  it means Android will refuse an in-place upgrade if you ever switch to a real keystore
  (uninstall first, which wipes app settings). If you intend to keep this long-term,
  generate your own keystore and point the release signing config at it before the first
  install.
- **The first native build is slow** (tens of minutes). Incremental builds after that are
  quick.

Sanity: `npm run typecheck` should be clean. The test suite is `npm run test:all` (bounded,
serial, heap-capped by `scripts/run-tests.mjs`).

---

## 5. Pair everything

Three things get configured: the reader's Wi-Fi, the reader's mailbox URL, and each phone's
settings.

### 5.1 Give the reader Wi-Fi

The reader needs a saved network before it can reach the mailbox on its own. Two ways:

**Directly on the reader:** Home → File Transfer → **Join a Network**, pick the SSID, type
the passphrase.

**From the phone (much nicer):** typing a WPA2 passphrase on e-ink with a chorded
five-button keyboard is the worst interaction in the product, so the credential can ride
the peer link instead:

1. Phone: **Settings → Share WiFi with reader** → enter SSID and password (Android cannot
   read the current network's password for any app at any API level — there is no prefill to
   be had; the SSID *is* offered).
2. Reader: **Home → File Transfer → Sync with App**. The panel shows the AP name and its
   passphrase.
3. Phone: **Library tab → Sync with reader**. The phone joins the reader's AP and the reader
   picks the credential up from `/cp-wifi` on the first poll of that session.

The credential is answered on its own local-only path that is never forwarded upstream, and
the pickup is gated to the AP transport only — the reader will never ask an internet mailbox
host for your Wi-Fi password.

> **This step is not optional and it is the #1 cause of "nothing ever arrives".** An empty
> credential store means every ambient sync window ends before it starts. See §7.

### 5.2 Point the reader at the mailbox

The reader ships with `messageSyncEnabled = 0` and `messageSyncUrl = ""`, and sleep-entry
sync returns immediately unless **both** are set. `messageSyncUrl` is deliberately hidden
from the on-device Settings screen (it is a long capability URL; nobody should type it on
e-ink), so it is written over the reader's web settings API.

**The easy way — from the app:**

1. Reader: Home → **File Transfer → Join a Network** (or *Create Hotspot*), so its web
   server is up and it is awake.
2. Phone (host role, mailbox URL already filled in): **Settings → Set up reader sync**.

That writes `messageSyncEnabled = 1` and `messageSyncUrl`, then **reads them back and
compares** — because the firmware's string setter truncates silently and answers 200 either
way, a 200 alone would not tell you the value survived.

**Then confirm on the device:** Settings → System → **Message Sync** is ON.

**Optional but recommended:** Settings → **Display** → **Sleep Screen** → **Custom**. (The
reader's Settings screen is grouped into Display / Reader / Controls / System.) That is the
mode that paints `/sleep.bmp` (or the `/.sleep/` rotation), i.e. the wallpaper a note
reverts to.
Notes take precedence over *every* sleep-screen mode, so notes work regardless; this only
affects what comes back afterwards.

### 5.3 The host phone

**Settings** on the phone that is physically paired with the reader:

| field | value |
|---|---|
| **Role** | `Host` |
| **Mailbox URL** | `https://mailbox.example.com/m/<box-id>` — the full base, exactly what the reader stores |
| **Mailbox Write Token** | `<write-token>` — stored separately from the URL, on purpose |
| **Device Host or IP** | `crosspoint.local`, or the reader's LAN address `192.168.x.y` |
| **Reader AP password** | the passphrase shown on the reader's panel in *Sync with App* mode; 8–63 printable ASCII. Leave blank if the reader's AP is open. |

Use **Test mailbox** to confirm the URL and token before you go further.

**About Device Host or IP** (that is the section's exact title in the app's Settings
screen): it takes a **bare host — no scheme, no port, no path.** The app
strips `http://`/`https://` and anything after the first `/`, but a **port is kept**, and
that breaks things: HTTP calls go to `http://<host>:<port>/api/files` and the WebSocket
upload builds `ws://<host>:<port>:81/`, which is malformed. If you self-host the mailbox on
`192.168.x.y:8790`, that port belongs in **Mailbox URL**, never here. Likewise, do not put
the reader's AP address here — that address is only reachable while you are joined to the
reader's own access point, not while you are on your LAN.

Host phones see five tabs: **Compose, History, Wallpaper, Library, Settings**.

### 5.4 The partner's phone

| field | value |
|---|---|
| **Role** | `Client` |
| **Mailbox URL** | the same base URL |
| **Mailbox Write Token** | the same token |

That is all. A client has no direct reader access and owns no permanent reader state, so
the Wallpaper and Library tabs are hidden — it sees **Compose, History, Settings**. Do not
give a client phone the Device Host or the AP password; they would do nothing.

> The role gate falls back to a *definite* role when settings are unreadable rather than
> leaking host-only UI, so a corrupted settings blob cannot turn a partner's phone into a
> host.

---

## 6. Use it

### Send a note

**Compose** → photo, text, or doodle → the live preview shows you what the e-ink panel will
actually render → send. History shows the delivery state.

**Which route the send takes** is decided per send, in this order:

1. **Direct**, if the app knows the reader is awake right now. A cheap
   `GET /api/files?path=/` probe answers that in a fraction of the time the real upload's
   cheapest leg takes to fail.
2. **Mailbox**, otherwise. Under a second, and it needs no reader, no proximity, and no
   further taps.
3. **Handover**, when you deliberately run *Sync with reader* (§6.4).

The app deliberately **under-promises**: with stale evidence and a mailbox configured it
says "mailbox" even though the send may re-probe, find the reader awake and upgrade itself
to direct. "On its way" turning out to be "Delivered" costs you nothing; the reverse is the
bug worth avoiding.

### What the reader shows, and when

**A new note IS the sleep screen, for exactly one sleep.** There is no banner, no toast, no
"you have mail" state to dismiss, and a note never interrupts reading.

| the note arrived while the reader was… | what happens | worst-case latency |
|---|---|---|
| **awake** | the sleep-entry sync stages it, and that same sleep-entry paints it | immediate — it is on the panel when you set the book down |
| **asleep** | the next wake runs a silent background check; the note takes the panel at the **next** sleep-entry | one wake→sleep cycle |

Then: **the next sleep, and every sleep after it, paints your configured wallpaper again**,
until a newer note arrives. The turn is consumed by the *paint*, not by you reading it, and
it is keyed on the note id rather than a flag — so a newer note always gets its own turn,
and a note that was staged but never actually reached the panel (the sync died mid-way, or
that sleep was a quick-resume) keeps its unspent turn for the next normal sleep.

Sync windows, for calibrating expectations:

- **Sleep entry** — every time the reader goes to sleep, if Message Sync is on, a mailbox
  URL is set, and a saved network is joinable.
- **Silent wake check** — a background fetch on wake; the panel is not touched.
- **Mailbox Sync** — Home → File Transfer → **Mailbox Sync**, an explicit drain over a
  saved network. Polls every 4 s, 30-minute hard session cap.

### Books and wallpaper

**Books.** Library tab → add an epub. Host phones try the reader directly first and fall
back to the mailbox; client phones publish to the mailbox only. Caps:

| | limit | why |
|---|---|---|
| via mailbox | **24 MiB** per epub, **20** epubs per box | Workers KV caps a value at 25 MiB; the manifest is fetched whole on every wake window so it cannot be unbounded. The 21st book evicts the oldest. |
| direct LAN upload | **8 MiB** | a transport limit, not a format one — the direct path materialises the whole file in memory twice over, and a bigger file is an out-of-memory *crash*, not an error message |

Books land in `/books` on the card and are readable the moment the sync exits. Downloads
resume via HTTP `Range`, so a book interrupted by a closing wake window continues rather
than restarting.

**Wallpaper.** Wallpaper tab → pick an image → set as sleep screen. Two targets:
`primary` writes `/sleep.bmp` (the active sleep screen; a new primary supersedes a pending
one rather than stacking), `set` writes `/.sleep/<name>.bmp` (the rotation folder). Up to
**8** pending wallpapers, **4 MiB** each. A wallpaper delivered over the mailbox can only be
*seen* at the next sleep — the sync screen's counts line is the receipt.

### Sync with App — the no-internet case

This is the route for "we are in the same room and there is no usable network", and for
draining everything at once on demand.

1. Reader: **Home → File Transfer → Sync with App**. The reader raises its own access point
   and shows the AP name and passphrase on the panel.
2. Phone (host): **Library tab → Sync with reader**.

The phone joins the reader's AP as a peer and then does one of two things, transparently:

- **Proxy** — forwards the reader's mailbox requests over cellular. Android keeps cellular
  as the default route while the phone sits on the reader's AP, which is the whole reason
  this is Android-only.
- **Local serve** — with **zero internet**, answers the reader from the phone's own outbox:
  notes and books you queued while offline are handed over directly, and History flips them
  to delivered.

Either way the reader sees exactly the same wire protocol it uses against the real mailbox.
The forwarder never receives your write token — the *absence* of anything that could
authenticate is the proxy's security property. Session cap is 30 minutes.

Note that a note staged during a sync still does **not** render on the panel there; it takes
its one turn at the next sleep, same as always.

---

## 7. Troubleshooting

Keep a serial monitor open (§2). Almost everything below announces itself there.

| symptom | cause | fix |
|---|---|---|
| **Nothing ever arrives. No error anywhere.** Serial: `WCS Loaded 0 WiFi credentials from file`, then `MSYNC No saved WiFi credentials` or `MSYNC Sleep sync skipped: no saved WiFi network joined` | The reader's credential store is **empty**. Every ambient sync window exits before it does anything. | Join a network on the reader, or share Wi-Fi from the phone over the peer link (§5.1). |
| Same silence. Serial: `MSYNC Sleep sync OFF: 'Message sync' is disabled in Settings > System` | The Message Sync toggle is off. Easy to hit by accident — it is one row away from other System rows. | Reader → Settings → System → **Message Sync** ON. |
| Same silence. Serial: `MSYNC Sleep sync OFF: no mailbox URL configured` | `messageSyncUrl` is empty, or the provisioning write never landed. | Re-run **Settings → Set up reader sync** from the host phone with the reader awake in a File Transfer mode. |
| **The reader polls forever and gets 404s.** Nothing wrong-looking anywhere except the serial log. | The base URL exceeded **127 characters** and was silently truncated by the firmware's `strncpy`. | Shorten the origin (or the box id) and re-provision. `checkReaderUrlBudget` in the app, and the self-host server's startup banner, both print the length. |
| **App says "not connected" while a mailbox is configured.** | This is **normal and expected**. The reader spends nearly all its time asleep with the radio off; "not connected" is its resting state, and the mailbox covers the gap. The banner deliberately goes silent when a mailbox is configured, and sends route to it. | Nothing. If a screen ever claims a note *cannot* be delivered while a mailbox is set, that is a bug — it is stating something false. |
| **Upload spins for 15–25 seconds, then succeeds.** | A direct-first send against a sleeping reader: the mkdir aborts after 10 s, the WebSocket burns its own timeout, and the note path does it twice (frame, then id sidecar). Pure discovery cost. | Already fixed by the fast-skip probe — the send asks one cheap question first and goes straight to the mailbox on "asleep". If you still see it, you have no mailbox configured, in which case direct is the only road and the wait is real. |
| **The note never goes away** — it re-shows on every wake, or holds the panel until the next note. | Pre-display-once firmware. The old model kept the latest note as the lock screen indefinitely. | Flash the `develop` branch (§2). Display-once + wallpaper revert is keyed on the note id (`messageLastDisplayedId`), so nothing can pin the panel. |
| **A send "works" but the panel still shows the previous image.** | The firmware **refuses to overwrite an existing path** and writes nothing (`ERROR: File already exists`). Any sender that does not delete-then-upload works exactly once per filename. | All three shipped senders delete first. If you wrote your own tooling against the WS protocol, add the `POST /delete` step (a 404 on the first send is normal). |
| **Direct sends fail, everything else works.** | Wrong value in **Device Host or IP**. It wants a bare host — no scheme, no path, and critically **no port**: a port is preserved and produces `http://<host>:<port>/api/files` and a malformed `ws://<host>:<port>:81/`. | Put `crosspoint.local` or `192.168.x.y` there. A self-hosted mailbox's port belongs in **Mailbox URL**. Never put the reader's AP address here — it is only routable while you are on the reader's AP. |
| **Entering Mailbox Sync says "no saved network in range"** while ambient sync works fine. | Observed once; suspected radio state on activity entry. Not fully characterised. | Retry. If it reproduces, capture the timing and the surrounding `MSYNC`/`MSYNCUI` lines — that is what a fix needs. |
| **A note published seconds ago is missed by one cycle.** | Workers KV is eventually consistent with a 60-second edge-cache floor. | Wait one cycle. This is delay, not loss — and by design a lagging replica can only 404 or serve a consistent *old* pair, never mismatched pixels under a new id. |
| **A book never appears.** | Over the cap (24 MiB via mailbox, 8 MiB direct), or evicted — the 21st book drops the oldest, and a new book replaces any entry with the same filename case-insensitively. | Check `GET {base}/books.txt` against what you expect. The reader tracks applied ids, so a book it already has will not be re-downloaded. |
| **Sync with reader is not offered.** | `isHandoverAvailable` requires role = host **and** a mailbox URL containing an `/m/<box-id>` path. A root-mounted base publishes fine but cannot be served over the AP. | Use the full base URL, the same one the reader stores. |

Two useful greps on serial: `MSYNC` (the sync engine's breadcrumbs — every gate it declines
at says why) and `MSYNCUI` (the interactive Mailbox Sync / Sync with App screen).

---

## 8. Security model

Read this before you paste your mailbox URL anywhere.

### What the capability URL grants

**Reads are protected by the URL and nothing else.** The firmware sends no auth headers on
any GET, so the box id **is** the read capability. It is 128 bits of CSPRNG entropy and not
guessable — but treat the base URL exactly like a password, because anyone holding it can:

- read `latest.txt` and download `current.frame` — the current note;
- list `books.txt` and download **every epub in the box**;
- list `wallpaper.txt` and download **every pending sleep screen**.

Sharing a base URL is sharing the library and the imagery, not just one note.

**To revoke:** mint a new box id and re-provision the reader. There is no other rotation.
Clean up the old box's keys afterwards (on Workers, `wrangler kv key list --prefix
'box:<id>:'` then delete each — frame keys carry the note id, so the prefix listing is the
reliable way to find them).

### What the write token grants

**Writes require the bearer token**, and it is a single global secret shared by every box on
the deployment. Consequences worth stating plainly:

- **A valid token can publish to any box id on that server.** A compromised token is a full
  compromise of that deployment. Rotate with `wrangler secret put WRITE_TOKEN` (or a
  restart with a new `$MAILBOX_WRITE_TOKEN` when self-hosting).
- It is stored **separately** from the mailbox URL in app settings and must **never** be
  embedded in the URL the reader receives — the reader would then hand a write credential to
  anything that can read its settings.
- Comparison is length-independent. A missing or under-16-character token makes every
  authenticated route return **503, not 200**: a blank secret must never silently mean
  "anyone may publish", which would turn the box id into a write capability too.

### The AP passphrase

`Sync with App` raises a WPA2 access point. Its passphrase is 8–63 printable ASCII, minted
per device, stored outside the normal settings blob so it survives a settings reset, shown
on the reader's own panel, and editable there (clearing the field is the documented
*regenerate* gesture — the next session draws a fresh one with the radio up, which is the
only place the hardware RNG is honest). It is masked in the reader's web settings API.

**The app's default is an empty passphrase**, which means an **open** AP — the shipping
firmware default. Set a real one.

### What is NOT protected — the honest list

- **The reader's Wi-Fi transfer mode is an open AP with an unauthenticated web API.**
  Anyone in range while it is up can `GET /api/settings`, browse files, upload and delete.
  Bring it up deliberately, and exit it when you are done.
- **The mailbox URL is stored in clear on the reader and is NOT masked in
  `GET /api/settings`.** This is a known, deliberate residual, not an oversight: the app's
  provisioning step writes the value and then reads it back and compares for equality, so
  masking it would make every provisioning attempt report failure. Closing it is a lockstep
  firmware + app change. Until then, anyone on the reader's LAN — or on its open transfer-mode
  AP — can read your capability URL.
- **The reader does not verify TLS certificates.** Every shipping firmware environment
  compiles the wolfSSL path, which calls `setInsecure()` and accepts any certificate. So
  HTTPS to the mailbox gives you encryption against a passive eavesdropper but **no
  authentication of the server**: an active on-path attacker can impersonate the mailbox.
  The convenient corollary is that a self-signed origin works fine for self-hosting — it is
  the same property, stated in the direction that helps you.
- **Nothing is encrypted at rest** on the mailbox host. Notes, books and wallpapers sit
  there as bytes.
- **There are no acknowledgements.** The server never learns what the reader received;
  reader-side state is authoritative. That is a deliberate design property (an ack is a
  write the reader would have to make inside a wake window), but it means the app cannot
  prove delivery.
- **The Worker sends no CORS headers.** The client is a React Native app, which is not
  subject to CORS. Do not add them unless a browser client genuinely appears.

### What follows from all that

1. **Treat the base URL as a secret.** Do not paste it into issues, screenshots, gists,
   pastebins, or a chat you do not control. It is the whole read-side security model.
2. **Never put the write token in the URL.** Keep it in its own settings field.
3. **Set an AP passphrase** rather than running the open default.
4. **Exit transfer mode** when you are done provisioning.
5. **Sanitise before you share logs.** Serial output and app diagnostics can contain the
   base URL, the SSID, and local addresses.
6. If a URL leaks, **mint a new box id and re-provision** — that is the rotation. If the
   *token* leaks, rotate the secret, and remember it was global.

---

## Where to read more

| topic | file |
|---|---|
| The wire contract — every route, every header, every invariant | [`docs/xteink/mailbox-books-contract.md`](xteink/mailbox-books-contract.md) |
| The note lock-screen model and display-once rule | same file, §3A |
| The peer link and phone-as-proxy design | same file, appendix A3 |
| Live sync / Mailbox Sync mode | same file, appendix A4 |
| Mailbox server — deploy, caps, storage layout, security | [`mailbox/README.md`](../mailbox/README.md) |
| Firmware seams and panel geometry | [`docs/xteink/crosspoint-firmware-assessment.md`](xteink/crosspoint-firmware-assessment.md) |
| Why this fork exists, and the milestone plan | [`docs/xteink/app-fork-plan.md`](xteink/app-fork-plan.md) |
| Self-host server CLI | `node scripts/mailbox_dev_server.mjs --help` |
| Upstream firmware user guide | the firmware repo's `USER_GUIDE.md` |
