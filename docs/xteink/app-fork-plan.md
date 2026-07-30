# Xteink X3 Messenger — App Fork Plan

Fork of **Xatpy/send-to-x4-mobile-app** into the CrossPoint-X3 private photo/note messenger.

- Clone: `C:/Users/Donovan/xteink-messenger/host-app/send-to-x4-mobile-app`
- HEAD: `a5d336094db962a22d422a64565ef10977474adf` — "Bump version" — 2026-03-23 (branch `main`, `--depth 1`)
- Assessed: 2026-07-27. **READ-ONLY** — nothing in the app was modified; `node_modules` not installed.

---

> ## ⚠ SUPERSEDED PANEL CONTRACT — CORRECTED 2026-07-28
> This plan was written on 2026-07-27, before the frames were ever put on a
> physical X3. **Its X-mirror assumption was WRONG.** Where the text below says
> "X-mirror", "X MIRRORED", "X-flipped" or "pack each row right-to-left" for the
> love-note `.frame`, read instead:
>
> - **NO X-MIRROR.** Columns pack LEFT-TO-RIGHT: stored bit `j` IS panel pixel
>   `x = j`, so panel `x = 0` is the MSB of byte 0. A mirrored pack renders the
>   note backwards on the panel.
> - **Portrait → landscape is 90° COUNTER-CLOCKWISE**, and CCW is the DEFAULT:
>   `lx = py`, `ly = 527 - px`. The `cw` variant renders exactly 180° off and
>   survives only as a diagnostic switch.
> - **Uploads must DELETE the target path first** — the firmware answers
>   `ERROR: File already exists` and writes nothing otherwise, so a re-send
>   silently leaves the previous note on the panel.
>
> Everything else in the geometry (52,272 bytes, 528 rows × 99 B, MSB-first,
> `1=white/0=black`, row 0 = landscape top) held up unchanged. The authority is
> `src/device/x3.ts`; `HANDOFF.md` carries the short version. The M1/M2 milestone
> text below is left as written, because de-risking exactly this assumption is
> what those milestones were FOR — and it is what caught the error.

---

## 1. Fork verdict

**Fork it.** This is close to an ideal base. It already speaks CrossPoint's exact wire protocol (HTTP `:80` + WebSocket `:81`), already has a firmware toggle with a dedicated `crosspoint` path, already does the hard React-Native-side work we'd otherwise build from scratch: image → device-format conversion, a share-sheet ingest pipeline, a `.txt`/note sender, a device file manager (browse/delete/mkdir), a connection/reachability context, a queue+retry uploader, and even a drawing canvas. License is **MIT (Copyright 2026 Chapiware)** — clean to fork/relicense-forward with attribution (keep `LICENSE`/`NOTICE`).

The two things it does *not* have and we must build: (a) our **528×792 1-bit `.frame` encoder** (its encoder targets X4 480×800 24-bit BMP; ~~with the X-mirror~~ → straight pack + 90° CCW, see the correction banner), and (b) **Android AP auto-join with cellular kept as default** (it assumes you're already on the reader's LAN). Everything else is reuse-or-adapt.

---

## 2. Repo assessment

### Versions / toolchain (package.json, app.config.ts, .nvmrc)
| Thing | Value |
|---|---|
| Framework | **Expo SDK ~54.0.33**, React Native **0.81.5**, React **19.1.0** |
| Language | **TypeScript ~5.9.2** (`tsc --noEmit` typecheck script) |
| Package manager | **npm** (only `package-lock.json`; no yarn/pnpm) |
| Node required | **>=20 <21** (`engines`), `.nvmrc` = `20`, README "Node 20.x" |
| Arch | New Architecture **enabled**, Hermes engine, `orientation: portrait` |
| Builds | iOS + Android (`expo run:ios` / `run:android`), EAS configured (`eas.json`, IDs via `.env`) |

Key deps we care about: `expo-image-manipulator` (resize/crop), `upng-js` (PNG→RGBA decode, Hermes-safe), `expo-file-system` (base64 file IO), `expo-share-intent` (share sheet), `@react-navigation/*` (bottom-tabs + native-stack), `@react-native-async-storage/async-storage` (settings), `react-native-view-shot` (canvas→PNG), `react-native-webview` (article extractor — droppable), `jszip`/`@mozilla/readability`/`linkedom` (EPUB/article — mostly droppable for a messenger).

### Structure
- `App.tsx` — nav root: native-stack (`MainTabs`, `Settings`, `SleepScreenDetail`) wrapping a bottom-tab navigator (Articles, Notes, Design, Images, x4ePapers, Device). Wrapped in `ConnectionProvider` + `ProgressProvider`. Share-intent routing lives here.
- State = **React Context**, not Redux. `src/contexts/ConnectionProvider.tsx` (settings + reachability), `src/contexts/ProgressProvider.tsx` (upload progress). Persisted settings via AsyncStorage in `src/services/settings.ts`.
- `src/services/` = all the logic (transport, encoders, queues, senders). `src/screens/` = 8 screens. `src/components/` = reusable UI. `src/x4/deviceConfig.ts` = hardware dims. `src/types/index.ts` = shared types.

### License
MIT, `Copyright (c) 2026 Chapiware`. `NOTICE` present. Fork-friendly.

---

## 3. How it connects to the reader today

No mDNS/NSD discovery code and **no AP-join** — it simply targets the hostname **`crosspoint.local`** (default `crossPointIp`) and relies on the OS resolving it over the shared LAN. There is a manual IP/hostname field in Settings.

- Default target + firmware toggle: `src/contexts/ConnectionProvider.tsx:32-42` (`firmwareType:'crosspoint'`, `crossPointIp:'crosspoint.local'`).
- Host normalize + base-URL build: `src/services/settings.ts:76-97` (`normalizeDeviceHost`, `getDeviceBaseUrl` → `http://<host>`).
- Reachability probe: `checkCrossPointConnection` `src/services/crosspoint_upload.ts:302-333` (GET `/api/files?path=/`).
- Re-checks on mount + app-foreground, gated by Android NEARBY_WIFI permission: `ConnectionProvider.tsx:56-92,119-130`; `src/services/android_permissions.ts`.

**CrossPoint endpoints already used** (all in `src/services/crosspoint_upload.ts` + `DeviceScreen.tsx`):
- WebSocket `ws://<ip>:81/` chunked upload, `START:<filename>:<size>:<path>` → `READY` → binary 4 KB chunks (128 KB in-flight window, `PROGRESS:cur:total` acks) → `DONE`/`ERROR:` — `crosspoint_upload.ts:53-173`.
- `GET /api/files?path=` list — `:254, :304, :365, :472`; `DeviceScreen.tsx:79`.
- `POST /mkdir` (multipart name+path, nested-safe) — `:272-290`.
- `POST /delete` (form `path`+`type`) — `:409, :522`.
- `/rename` and `/download` exist in firmware but are **not** called by the app today.

---

## 4. Reusable features + what must change

| Feature | Where | Verdict |
|---|---|---|
| **Transport (WS :81 + HTTP :80)** | `crosspoint_upload.ts` | **Reuse as-is.** `uploadToCrossPoint()` / `uploadLocalFileToCrossPoint()` / `uploadScreensaverToCrossPoint()` all funnel through `uploadViaWebSocket()`. A love-note upload = call it with `filename='current.frame'`, `targetPath='/.love-notes'`, plus `ensureFolderExistsCrossPoint(ip,'.love-notes')`. |
| **File manager** (browse/delete/folders) | `DeviceScreen.tsx` (recursive scan via `/api/files`, swipe-delete via `/delete`), `crosspoint_upload.ts` list/delete/mkdir | **Reuse for host/epub role.** Retarget roots from article/note/sleep to `books`/epub + `.love-notes`. |
| **Photo → device image** | `image_converter.ts` + `bmp_encoder.ts` + `x4/deviceConfig.ts` | **Front-end reuse, back-end replace.** Pipeline = `manipulateAsync` cover-crop → PNG → `UPNG.decode`→RGBA is reusable. **Confirmed:** it targets **X4 480×800, 24-bit BGR, bottom-up .bmp** (`deviceConfig.ts:7-8` `480×800`; `bmp_encoder.ts` 24bpp/1,152,054 B). **Must build new** the X3 packer (see §6/M2). |
| **Note / text send** | `note_sender.ts` (`.txt` via same WS pipeline), `note_epub_sender.ts` | **Reuse** for a plain-text "note" path; but our note is *rendered to a `.frame`*, so the real reuse is the composer UI + upload, not the `.txt` write. |
| **Share-sheet ingest** | `App.tsx:149-213` (`expo-share-intent`), config in `app.config.ts:75-87` | **Reuse.** Already routes shared **image → Images tab** and **text → Notes tab**. Re-point to our compose-and-send-love-note flow. |
| **Drawing canvas → PNG** | `SleepScreenTab.tsx` (`react-native-view-shot`, `viewShotRef`, `captureRef`, PNG q=1 at `:448-480`) | **Reuse** as the seed for a note/doodle composer — capture canvas → PNG → our frame encoder. |
| **Connection state, progress, queue+retry, settings, Android net plugin** | `ConnectionProvider`, `ProgressProvider`, `queue_*`, `settings.ts`, `plugins/with-local-network-security.js` | **Reuse.** The cleartext-HTTP + local-networking Android plugin is exactly what our LAN/AP traffic needs. |
| Article extractor, EPUB builder, Hobonichi/PDF, lowio wallpaper browser, x4papers | `extractor.ts`, `epub_builder.ts`, `HeadlessWebView`, `lowioWallpapers.ts`, `SleepScreen*`, `ScreensaversScreen` | **Drop / defer.** Out of scope for a private messenger; delete to shrink surface (keep canvas capture bits). |

### The X4→X3 encoder change (critical)
Existing (`bmp_encoder.ts`): 480×800, 24 bits/px, BGR, bottom-up rows, 54-byte BMP header, ~1.15 MB.
New target (verified device facts): **792×528 landscape buffer, 1 bit/px, MSB-first, 99 bytes/row × 528 rows = exactly 52,272 bytes, `1=white/0=black`, no header, raw `.frame`.** Column order — ~~X MIRRORED (pack each row right-to-left)~~ → **NO X-mirror: pack each row LEFT-TO-RIGHT, stored bit `j` = panel `x`** (corrected on hardware 2026-07-28). Compose the message portrait at **528×792**, then map into the 792×528 landscape buffer with a **90° COUNTER-CLOCKWISE** rotation (`lx = py`, `ly = 527 - px`). Add a grayscale + threshold/dither step (currently none — it just copies RGB). Cover-crop logic in `image_converter.ts:73-107` is reusable with the target dims swapped.

---

## 5. Toolchain / run story (+ Node status)

- **Node: PRESENT but MISMATCHED.** Machine has **Node v24.5.0 / npm 11.5.1**; project pins **Node 20** (`engines >=20 <21`, `.nvmrc`, README). Expect install/tooling friction on 24 — README explicitly warns "newer Node majors may fail on tooling transforms." **Action: install Node 20 (nvm-windows) before `npm install`.**
- `git` 2.52 present. A global `npx expo` resolves to 57.0.10, but inside the project `npx expo` uses the pinned **SDK 54** local CLI after `npm install`.
- **This is a dev-client app, not Expo Go**: custom config plugin (`with-local-network-security`), `expo-share-intent`, native perms, `newArchEnabled` → must **`expo prebuild`** then run a dev build. `ios/` and `android/` are **not** checked in (prebuild artifacts).
- **Android run** (`npx expo run:android`) needs Android Studio + SDK 36 + JDK. **None installed on this machine** (no `java`, no `adb` on PATH, no `ANDROID_HOME`/`ANDROID_SDK_ROOT`). Install those (or use EAS cloud builds) to get an APK/dev-client onto a physical phone; then `npx expo start --dev-client`.
- **iOS**: supported by the project, but **cannot build locally on this Windows machine** (needs macOS + Xcode 15+ + CocoaPods). iOS parity via a Mac or EAS only.

**Bottom line to run on a physical Android phone here:** install Node 20 + Android Studio/SDK 36 + JDK → `npm install` → set `.env` (bundle IDs, EAS) → `npx expo prebuild --clean` → `npx expo run:android` (device in USB-debug) → thereafter `npx expo start --dev-client`. Or skip local Android setup and use **EAS build** for the dev client.

---

## 6. Reuse / Adapt / Build-new

**Reuse as-is:**
- `crosspoint_upload.ts` WS+HTTP transport (`uploadViaWebSocket`, `ensureFolderExistsCrossPoint`, list/delete/mkdir, `checkCrossPointConnection`).
- `ConnectionProvider` / `ProgressProvider` / `queue_*` / `settings.ts` (extend, don't rewrite).
- `plugins/with-local-network-security.js`, `android_permissions.ts`.
- `DeviceScreen.tsx` file-manager scaffolding (retarget roots).
- Share-intent plumbing in `App.tsx`; `react-native-view-shot` canvas capture.

**Adapt:**
- `image_converter.ts` — keep manipulate→PNG→UPNG→RGBA front-end; swap target dims and call the new packer instead of `encodeRGBAToBMP`.
- `x4/deviceConfig.ts` — replace with X3 geometry (792×528 landscape / 528×792 compose, 99 B/row, 52,272 B) or add a device profile.
- `note_sender.ts` / composer screens — render to `.frame` instead of `.txt`.
- `settings.ts` + `ConnectionProvider` — add pairing secret + AP SSID + role (sender/host) alongside `crossPointIp`.
- Nav (`App.tsx`) — collapse 6 content tabs to a messenger shape (Compose / History / Device[host-only]).

**Build new:**
- `src/services/frame_encoder.ts` — RGBA → 1-bit **straight-packed, 90° CCW** 528×792→792×528 `.frame` packer (grayscale+threshold/dither, MSB-first, 99 B/row, assert 52,272 B).
- `src/services/love_note_sender.ts` — thin wrapper: encode → `ensureFolderExistsCrossPoint(ip,'.love-notes')` → `uploadViaWebSocket(ip,'current.frame',data,'/.love-notes')`.
- **Android AP auto-join** module — `WifiNetworkSpecifier` join to `CrossPoint-Reader`, bind upload socket to that network while cellular stays default (native module or config-plugin; RN's `fetch`/`WebSocket` don't expose per-request network binding, so this needs native `Network.bindSocket`/`ConnectivityManager` glue).
- **Mailbox client** — tailnet HTTPS queue/history client + a message-history UI (partner→mailbox→host→reader).
- **Pairing** flow/store (app-side secret; no e-ink password typing).

---

## 7. Milestones (mirror the firmware's incremental style)

- **M1 — Prove the pipe.** On the reader's LAN (hostname `crosspoint.local`, reuse existing transport untouched), upload a hand-built 52,272-byte test `.frame` to `/.love-notes/current.frame` and confirm the love-note renders on the X3. *Seam:* new `love_note_sender.ts` calling `uploadViaWebSocket` (`crosspoint_upload.ts:53`); `ensureFolderExistsCrossPoint` for `.love-notes`. Validates path, WS protocol, and the mirror/orientation assumption end-to-end before writing the encoder. **OUTCOME 2026-07-28: the assumption was wrong — no X-mirror, and CCW (not CW) is upright; the firmware also refuses to overwrite an existing path.**
- **M2 — Encoder + composer.** Build `frame_encoder.ts` (photo/canvas → 528×792 1-bit, ~~X-flipped~~ straight-packed) + adapt `image_converter.ts` front-end; a Compose screen (pick photo / type note / doodle via reused `view-shot` canvas) → preview → send. *Seam:* `image_converter.ts`, `x4/deviceConfig.ts`, new Compose screen off `App.tsx`; reuse share-intent (`App.tsx:149-213`) to ingest a shared photo straight into Compose. **De-risk the mirror + 528×792↔792×528 mapping here against M1's on-device result.** (Done: M1 disproved the mirror and fixed the rotation direction to CCW.)
- **M3 — Pairing + AP auto-join.** Store pairing secret; build the Android `WifiNetworkSpecifier` join to `CrossPoint-Reader` with cellular kept default and the upload socket bound to the AP. *Seam:* new native/plugin module; extend `settings.ts` + `ConnectionProvider` with role + AP creds; connection probe falls back AP→LAN.
- **M4 — Mailbox + history.** Tailnet HTTPS client (partner→mailbox→host→reader) + message-history UI; host phone drains mailbox and forwards to reader via M1 path. *Seam:* new `mailbox_client.ts` + History screen; reuse `queue_*` retry semantics and `ProgressProvider`.
- **M5 — Host/epub file manager.** Host-role reader library management (upload/delete/browse epubs). *Seam:* reuse `DeviceScreen.tsx` retargeted to the books folder + existing list/delete/mkdir/upload; gate behind role = host.

Ordering rationale: M1 reuses 100% existing transport to validate the device contract cheaply; M2 is the one genuinely new bit of DSP; M3/M4 are the new connectivity/backend; M5 is almost free reuse.

---

## 8. Key risks

- **X3 vs X4 geometry/format** is the central rewrite: 792×528 1-bit vs 480×800 24-bit, plus the column order and the 528×792-compose→792×528-buffer rotation. Nail the exact pixel mapping on-device in M1/M2 (a wrong flip/rotation is silent — it just looks mirrored/rotated). **Nailed 2026-07-28: no mirror, 90° CCW.** Assert output is exactly **52,272 bytes**.
- **Android AP-join while keeping cellular** is the hardest new engineering: `WifiNetworkSpecifier` + per-socket network binding is fiddly across Android versions, and RN `fetch`/`WebSocket` don't expose network binding — needs a native shim. Risk of the OS routing the upload over cellular (fails) or dropping cellular (phone offline for mailbox).
- **Background delivery**: host phone must drain the mailbox and forward even when app is backgrounded — Android/iOS background execution limits; likely needs a foreground service / push wake. Not in the base app at all.
- **iOS parity**: base supports iOS but can't be built on this Windows machine; the AP-join native module is entirely different on iOS (`NEHotspotConfiguration`) and more restrictive. Treat iOS as a later track.
- **Node/toolchain mismatch** (Node 24 vs pinned 20) — install Node 20 first to avoid transform failures.
- **`current.frame` single-slot** semantics: uploading over the same path is last-write-wins; message *history* lives in the mailbox, not the reader. Keep that boundary clear.
- **Open AP security**: `CrossPoint-Reader` AP is currently open; the app-stored pairing secret is the only gate — design M3's auth so an open AP isn't a trust hole.

---

## Feature: Sleep / lock-screen wallpaper (added 2026-07-27 per user)

The app must own the entire **photo → reader wallpaper** flow AND the image-prep tooling — no manual PC steps.

**Flow**
1. Pick a photo (reuse existing image picker / share-intent).
2. Prepare an X3 BMP — a NEW packer, distinct from the X4 24-bit `bmp_encoder.ts` and the love-note 1-bit `frame_encoder.ts`:
   - **8-bit grayscale, BI_RGB (uncompressed), 256-entry grayscale palette, bottom-up rows.** Verified-good format (bpp=8, compression=0, grayscale palette → firmware `hasGreyscale()` true → nicer multi-pass gray render).
   - Grayscale + gentle autocontrast for e-ink; long side ~1056. Firmware scales/crops to 528x792 via its sleep-cover settings and draws through `drawBitmap` (orientation-aware) → **NO rotation here** (unlike the raw love-note frame, which the app rotates 90° CCW itself). Neither path X-mirrors.
3. Upload via the EXISTING transport (`crosspoint_upload.ts`, WS :81 / HTTP) to **`/sleep.bmp`** (SD root, top priority) — or to **`/.sleep/<name>.bmp`** to build a rotating wallpaper set (firmware picks random, excludes recent).
4. Ensure sleep mode = CUSTOM: investigate whether the web-server settings API (`SettingsPage.html`) can set `sleepScreen=CUSTOM` + cover mode (CROP vs fit) + filter remotely; else document a one-time on-device toggle (Settings -> Sleep Screen -> Custom).

**Firmware refs:** `SleepActivity::renderCustomSleepScreen` (`/sleep.bmp` | `/.sleep/*.bmp`), `renderBitmapSleepScreen` (scale/crop/gray), `BmpViewerActivity::doSetSleepCover` (on-device "set as sleep cover"), `lib/JpegToBmpConverter` + `lib/PngToBmpConverter` (8-bit gray reference output).

**Reuse:** image picker + upload transport. **Build-new:** grayscale-BMP packer, wallpaper screen, optional wallpaper-set manager, remote sleep-mode setter (if API allows).

**Milestone fit:** slot as **M2b** (after the 1-bit frame encoder / compose screen — shares the image-prep front-end). Cheap, high-delight, validates the image->BMP->upload path independent of the 1-bit halftone/rotation complexity.

### Shared image-prep tooling (client-side, user-controllable)

All resize/crop/fit happens IN THE APP (spec: "expensive image work on Android"), producing device-ready output at the exact target resolution — firmware does minimal work. Shared front-end feeds both the wallpaper BMP packer and the love-note 1-bit `frame_encoder`:

- **Interactive crop/preview** before send: user frames the photo; toggle **Crop-to-fill** vs **Fit/letterbox** (this photo = 2 faces side-by-side → letterbox keeps both, crop cuts one — surface that choice).
- **Resize** with quality resampling (Lanczos) to the target: wallpaper -> ~fit 528x792 (or long-side ~1056 if deferring final crop to firmware); love-note -> exactly 528x792.
- Grayscale + autocontrast (e-ink punch); love-note path adds 1-bit dither + 90° CCW rotation + straight MSB-first pack; wallpaper path emits 8-bit grayscale BMP.
- Show an **e-ink preview** (grayscale/dithered) so what you see ≈ what renders.

Reuse `image_converter.ts` manipulate front-end (already does resize/format) + `view-shot`; add the target-specific packers + a crop UI.

---

## Roles & permission model (locked 2026-07-27)

One app, two roles, split by **permanent vs temporary** device state:

**HOST role** (phone paired to a reader; direct local access via reader AP / LAN):
- Owns PERMANENT state: set the **lock-screen wallpaper** (`/sleep.bmp`, persists across sleeps), manage **epubs**, device settings.
- Is the **bridge** for incoming messages: polls the tailnet mailbox and relays love-notes to the reader (pushes over local WiFi/AP on wake).
- Only the host touches the reader's persistent filesystem/settings.

**CLIENT / sender role** (trusted partner phones, remote; NO direct reader access):
- Compose + send **temporary** photo/note messages -> tailnet mailbox only.
- View message history. Cannot change wallpaper/epubs/settings.

**Delivery path:** client -> mailbox -> host (relay) -> reader. Clients never write the reader's permanent state; that's the trust boundary. Wallpaper is host-only; love-notes are ephemeral (shown on wake via `MessageDisplayActivity`, dismiss returns to reading, permanent wallpaper resumes on next sleep).

**Milestone tagging:** M2b wallpaper = HOST feature. Love-note compose/send = CLIENT feature. Both in one codebase, role-gated by whether the phone is paired-as-host.

---

## Additional features (2026-07-27)

**Promote a love-note -> permanent (HOST-only):**
- Any received/kept love-note can be "promoted" to permanent lock-screen art.
- Slick fit: promoted notes ADD to the `/.sleep/` set — firmware already random-rotates `/.sleep/*.bmp`, so your favorite notes become the CYCLING lock screen ("cute history on the e-ink"). Or pin one as the single `/sleep.bmp`.
- Encoding: prefer re-deriving from the ORIGINAL source photo (retained in mailbox/history) -> 8-bit grayscale wallpaper BMP (nicer than 1-bit). Fallback: convert the stored 1-bit `.frame` -> BMP.
- Host-only (permanent state = trust boundary); surfaced from the message-history / received-note view.

**In-app e-ink preview before send/save (BOTH roles):**
- First-class WYSIWYG-ish preview at device aspect (528x792): apply the same grayscale + (love-note) 1-bit dither the device will, so the user sees the approximate e-ink result BEFORE sending a note or saving a wallpaper.
- Wired into the crop/fit framing UI; live-updates as they adjust. Kills "looked fine on the phone, bad on e-ink."
