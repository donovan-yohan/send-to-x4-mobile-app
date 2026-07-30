# Xteink Messenger — Build Brief (app + mailbox server)

Hand-off from the firmware side (a separate repo, already MVP-complete). You build the **Android app** (this repo, branch `messenger`) and a **mailbox server**.

## Read first
`HANDOFF.md`, `docs/xteink/app-fork-plan.md` (THE plan — milestones, reuse/adapt/build, roles, features), `docs/xteink/crosspoint-firmware-assessment.md`, `~/xteink-x3-photo-messenger-project-spec.md`.

## Product
Two partners send each other a photo or short note ("love note") that appears on an Xteink X3 e-reader (CrossPoint fork). Plus: host-only permanent lock-screen wallpaper, epub management, and "promote a note to permanent".

## Delivery model (decided)
- Reader has no cellular. It reaches the internet via home WiFi OR the partner's phone **hotspot** (reader joins as client → internet through the phone's cellular = "connection through host device").
- **Pull, executed at SLEEP:** when the reader goes to sleep it connects (fail-fast 6s) and PULLS the latest note from the mailbox, stages it locally; the NEXT wake renders it instantly. No network in the read path; never interrupts reading. **Dedup by note id — each note shown exactly once.**
- Therefore clients/app POST to the MAILBOX (not directly to the reader) for remote delivery. Direct reader access (LAN / reader-AP) is HOST-only (epub mgmt, wallpaper, pairing/config, optional together-push).

## Roles (ONE app, two roles)
- **HOST** (phone paired to a reader; direct LAN/AP access): provisions the reader (messageSyncUrl, WiFi creds), manages epubs, sets the permanent wallpaper, promotes notes to permanent.
- **CLIENT** (trusted partner phones, remote): compose + send temporary love-notes → mailbox; view history. No direct reader access. Trust boundary: clients never write the reader's permanent state.

## Device / frame facts (VERIFIED — do not deviate)
- Panel 792x528 landscape, 1-bit.
- **Love-note frame = EXACTLY 52272 bytes**, 99 bytes/row, MSB-first, **1=white / 0=black**, **X-MIRRORED** (pack columns right-to-left — the encoder MUST flip X). Wrong byte count = firmware rejects.
- **Wallpaper (permanent, host-only)** = 8-bit grayscale BMP (BI_RGB uncompressed, 256-entry grayscale palette) → upload to reader `/sleep.bmp` (or `/.sleep/<n>.bmp` for a rotating set). Firmware scales/crops/dithers and is orientation-aware → **NO X-mirror for wallpaper.** Reader sleep mode must be set to CUSTOM.

## THE CONTRACT — mailbox <-> firmware (build the server to match; firmware already expects this exactly)
Per-recipient base URL = the reader's `messageSyncUrl` (a **Tailscale Funnel** public HTTPS URL with an unguessable per-reader token in the path = capability-URL auth). Must be reachable from the public internet (reader may be on home WiFi or a phone hotspot).
- `GET {base}/latest.txt` -> tiny plain-text body = the latest note's **id** (empty body = no note). Hit on EVERY enabled sleep — keep it tiny and fast (this is the cheap dedup probe).
- `GET {base}/current.frame` -> the raw 1-bit framebuffer, **EXACTLY 52272 bytes** (the latest note for that reader).
- Firmware supports http (LAN) and https (TLS 1.3); prefer https via Funnel.
- `id` = any stable token <=128 chars (ULID/hash); changes only when the note changes (latest-wins).

## Build 1 — MAILBOX SERVER (new; small, self-hostable on the tailnet)
- Per-recipient: store current note (52272-byte frame + id + metadata: sender, timestamp, optional caption) + full history.
- **Reader-facing** (Funnel, capability-URL): the two GETs above.
- **App-facing** (tailnet, Tailscale-ACL auth): POST new message (sender uploads the composed 52272-byte frame + metadata for a recipient; server sets it as that recipient's current + new id), GET history, optional ack.
- Delivery policy: latest-message-wins for the reader; history keeps all.
- Pairing: mint a per-reader capability URL/token that the HOST app writes into the reader's `messageSyncUrl`.
- Document run + Funnel setup.

## Build 2 — APP (fork already on branch `messenger`)
Per `docs/xteink/app-fork-plan.md`. New pieces:
- **frame_encoder**: image/canvas -> 528x792 1-bit, MSB-first, 1=white/0=black, **X-mirrored**, EXACTLY 52272 bytes (assert the byte count — top correctness risk).
- **wallpaper BMP packer**: photo -> 8-bit grayscale BMP (256-gray palette) -> reader `/sleep.bmp` via the existing LAN transport (host).
- **shared crop/fit + e-ink preview** (grayscale + 1-bit dither at device aspect) before send/save.
- **mailbox client**: sender POSTs frame+metadata; history fetch; ack.
- **pairing + provisioning**: host pairs a reader, writes messageSyncUrl (capability URL) + saves WiFi/hotspot creds into it (via the reader's existing CrossPoint web settings / server API in `src/network/crosspoint_upload.ts` + settings endpoints).
- **message history UI**.
- **promote-to-permanent** (host): add a chosen note to the reader's `/.sleep/` rotation (re-derive a grayscale BMP from the ORIGINAL photo, not the 1-bit frame).
- Role gating (host vs client). Reuse `crosspoint_upload.ts` for LAN/AP host ops.

## Toolchain (this devbox, on tailnet)
- `nvm use 20` (repo `.nvmrc` pins 20; box default is 24). `node_modules` + Android prebuild already present.
- APK: `cd android && ./gradlew assembleDebug` (first native build ~15-25 min; `android/gradle.properties` already tuned serial/4G — a parallel build OOM-hangs this box). Metro: `npx expo start --dev-client` (phones on the tailnet reach it). Android only for now; iOS needs a Mac.
- Gotcha: `android/` is gitignored Expo prebuild output — `expo prebuild --clean` WIPES the gradle tuning; move it to `app.json` to persist.

## Suggested order (each testable end-to-end)
1. Mailbox skeleton + the 2 reader-facing endpoints + Funnel -> lets the firmware be tested live.
2. App: frame_encoder + compose + mailbox POST -> send a real note; force a reader sleep -> confirm it pulls + renders on next wake, correct orientation, dedup (same note not reshown).
3. Wallpaper + e-ink preview + host LAN ops.
4. Pairing + provisioning.
5. History + promote-to-permanent.

## Firmware config the app provisions onto the reader
`messageSyncUrl` = the per-reader mailbox base (capability URL); `messageSyncEnabled` = on; saved WiFi for the paired host/hotspot (ideally last-connected so it's tried first within the 6s budget). Firmware currently ships this OFF/empty (dormant) until provisioned.
