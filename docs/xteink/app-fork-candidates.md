# Xteink X3 / CrossPoint — App Fork Candidates Research

_Research date: 2026-07-27. Target device: Xteink X3 running CrossPoint firmware (ESP32-C3, BLE + 2.4 GHz WiFi, microSD). Goal: fork rather than build-from-scratch for (1) a HOST/companion EPUB manager and (2) a partner-facing photo/note SENDER with message history._

---

## TL;DR

- **Do NOT build the transport from scratch.** Three actively-maintained, openly-licensed phone companion apps already implement working clients for CrossPoint's WiFi protocol (HTTP REST on :80, chunked WebSocket upload on :81, WebDAV, plus device-side OPDS/Calibre pull). That client — multipart/chunked upload, file CRUD, device discovery, EPUB packaging, gallery-photo→480x800 BMP screensaver conversion — is the hard 60-70% of both apps, and it already exists.
- **Best single fork base for the whole "xteink-messenger" (both needs): `Xatpy/send-to-x4-mobile-app` — MIT, React Native/Expo, Android + iOS.** It already sends EPUBs, **text notes**, and **photos** (gallery → BMP), has a device file manager (browse/delete), and explicitly supports **CrossPoint** firmware. You add the "messenger" layer (message-history view, photo-as-message model, trusted-partner pairing).
- **If native Android Kotlin is a hard requirement:** fork `andrew-malitchuk/inkcast-kmp` — **Apache-2.0**, Kotlin Multiplatform + Compose, Android + iOS, full file CRUD, production-ready.
- **Avoid building on `zabirauf/crosspoint-sync` unless AGPL-3.0 is acceptable** — it is the most polished uploader, but its network-copyleft license would force full source disclosure of your product.
- **BLE is a dead end for data.** CrossPoint's "Bluetooth Page Turner" makes the reader a **BLE HID keyboard host** (it consumes keypresses from generic page-turners); it is **not** a data channel and does **not** imply a companion-app BLE protocol. All file/photo/note transfer is over WiFi.

---

## 1. Is there an official/community CrossPoint companion app? YES — several

| App | Repo | License | Stack | Platforms | Stars | Last code push | Speaks CrossPoint protocol? |
|---|---|---|---|---|---|---|---|
| **Send to X4** | `github.com/Xatpy/send-to-x4-mobile-app` | **MIT** | React Native / Expo, TypeScript | **Android + iOS** | 26 | 2026-03-23 (repo touched 2026-07-23) | **Yes — explicit dual Stock + CrossPoint support** |
| **CrossPoint Sync** | `github.com/zabirauf/crosspoint-sync` | **AGPL-3.0** | React Native / Expo, TS (Tamagui, Zustand) | iOS-primary (Android buildable) | 47 | 2026-06-09 (most active) | **Yes — REST :80 + WebSocket :81** |
| **Inkcast** | `github.com/andrew-malitchuk/inkcast-kmp` | **Apache-2.0** | Kotlin Multiplatform + Compose MP (Ktor, Koin, Orbit-MVI) | **Android + iOS** (desktop on roadmap) | 34 | 2026-04-04 (repo touched 2026-07-27) | **Yes — WiFi HTTP + WebSocket** |
| **XTLibre** | `github.com/shakogegia/xtlibre` | **MIT** | TypeScript (self-hosted server) | Self-hosted web / server | 62 | 2026-04-07 | Yes — pushes over WiFi + exposes **OPDS** |
| Official Xteink app + XT-Cloud | (closed) | Proprietary | — | iOS + Android | — | — | Cloud sync; not forkable |
| Bookshelf: Book Tracker | (closed, App Store/Play) | Proprietary | — | iOS + Android | — | — | Reading-progress sync only (not file transfer) |

**Bottom line on "official/community app":** There is an official Xteink iOS/Android app tied to their proprietary XT-Cloud, but it is closed and cloud-locked. The community has produced **four** open companion tools, three of which are forkable phone apps that already talk to CrossPoint over local WiFi.

### Does the "Bluetooth Page Turner" give us a reusable BLE protocol? No.
Investigated the firmware and the upstream discussion (`crosspoint-reader/crosspoint-reader` Discussion #117) plus the local SDK (`freeink-sdk/libs/network/BleKeyboardHost`, `freeink-sdk/docs/ble-keyboard-host.md`). The page-turner feature makes the **reader act as a BLE HID keyboard _host_**, pairing generic HID remotes (Gamebrick, Free2/Free3, Kobo Remote, etc.) and mapping keypresses to page turns. It is only enabled after a book is open (RAM constraints), WiFi and BLE **cannot run simultaneously** (shared radio), and the BLE build disables images/CSS to fit. There is **no custom GATT data service and no companion-app BLE channel** to reuse. Conclusion: design the messenger around **WiFi**, not BLE.

---

## 2. The actual CrossPoint transfer protocol (what any fork must speak)

Confirmed directly from the firmware in this repo (`firmware/crosspoint-reader/src/network/CrossPointWebServer.cpp`). The device runs an HTTP server (default :80) + a WebSocket server (:81) + a WebDAV handler:

```
GET  /                      GET  /files            GET  /api/status
GET  /api/files             GET  /download
POST /upload   (multipart form-data — book/file upload)
POST /mkdir    POST /rename POST /move   POST /delete
GET/POST /api/settings
GET  /fonts    GET  /api/fonts   POST /api/fonts/upload   POST /api/fonts/delete
GET/POST /api/opds   POST /api/opds/delete      (manage OPDS servers)
GET/POST /api/wifi   POST /api/wifi/delete
WebDAV handler mounted on the server
WebSocket server on :81  (fast chunked binary uploads, ~64 KB chunks)
```

Plus **device-side pull** paths (the reader fetches content itself): an **OPDS browser** (up to 8 saved servers, search, paginated download), a **Calibre wireless connect** flow, and **WebDAV**. Native ingest formats: `.epub`, `.xtc/.xtch`, `.txt`, `.bmp`.

**Implication for architecture:** you have two integration models, and existing apps use both:
- **Push** (phone → reader): multipart `POST /upload` or WebSocket chunked upload to the reader's LAN IP (or reader in AP mode). Used by Send to X4, CrossPoint Sync, Inkcast.
- **Pull** (reader → server): reader polls an **OPDS**/WebDAV/Calibre endpoint. Used by XTLibre. This is the natural backbone if you ever need **off-LAN / remote** delivery (see the gap note under Need 2).

---

## 3. Candidate deep-dive & FIT scoring

### A. `Xatpy/send-to-x4-mobile-app` — MIT — RN/Expo — Android+iOS — 26★
- **Health:** Not archived; created 2026-02-04, last code push 2026-03-23, repo metadata touched 2026-07-23. 62 commits, 5 open issues, 2 forks. Solo-maintainer, moderately active (slightly quiet the last ~4 months but current).
- **Features:** share-sheet ingest of **URLs, text, and images**; article→clean-EPUB extraction (incl. Twitter/X threads via headless browser); **notes** with `.txt`/`.epub` export; **screensaver/sleep-screen designer** with freehand doodles; **gallery photo → 480x800 BMP**; `.xtc` native transfer; article queue with offline pre-fetch; date-based folders; **device file manager (browse + swipe-delete)**; local WiFi transfer, no cloud; **dual firmware compat (Stock + CrossPoint)**.
- **FIT (1) EPUB manager: STRONG.** Already has file manager, EPUB/XTC transfer, delete, folders, CrossPoint support.
- **FIT (2) photo/note sender: STRONGEST available.** The only existing app that already sends **both photos and text notes** and accepts images via the OS share sheet. Missing pieces are additive UI, not plumbing: a dedicated **message-history / conversation view**, treating a photo as a "message" (inbox) rather than a screensaver, and a **trusted-partner pairing/identity** model.
- **License note:** MIT — you may keep your fork/additions private and commercial. Best-fit license for a "private messenger."

### B. `zabirauf/crosspoint-sync` — AGPL-3.0 — RN/Expo — iOS-primary — 47★
- **Health:** Best-maintained of the RN apps — created 2026-02-07, last code push 2026-06-09, 108 commits, 6 open issues, 5 forks. Not archived.
- **Stack:** Expo SDK 54 / RN 0.81, Tamagui v2 UI, Zustand persistence, `react-native-udp` for UDP device discovery. iOS is the primary target (native modules require a dev build); Android is buildable but secondary.
- **Features:** UDP-broadcast device discovery, file browser with folder create/manage, **EPUB upload via WebSocket in 64 KB binary chunks** (matches firmware :81 exactly), upload queue with retry, format/destination prefs, sleep-screen image upload with grayscale preview, Safari Web Clipper extension.
- **FIT (1): STRONG** (polished discovery + upload + file browser). **FIT (2): WEAK** — image only as screensaver, **no notes, no message history**.
- **License warning:** **AGPL-3.0 is network copyleft.** Forking it forces you to release your entire app's source under AGPL, including server-side/network use. For a private product, prefer to **study/borrow patterns** (respecting the license) rather than fork. Note: GitHub's API reports `NOASSERTION` for the license field, but the `LICENSE` file is unambiguously "GNU Affero General Public License v3, Copyright (C) 2026 Zohaib Rauf."

### C. `andrew-malitchuk/inkcast-kmp` — Apache-2.0 — Kotlin Multiplatform — Android+iOS — 34★
- **Health:** Created 2026-03-03, last code push 2026-04-04, repo metadata touched 2026-07-27, 1 open issue. Described as functional/production-ready, ~47 commits, clean modular architecture.
- **Stack:** Kotlin Multiplatform + **Compose Multiplatform** 1.10.2, **Ktor** 3.1.3 (OkHttp/Darwin engines, WebSockets), Orbit-MVI, Koin DI, CouchbaseLite + DataStore. This is the **native-Kotlin** option (no React Native).
- **Features:** device discovery + manual IP; **full file management (upload/download/rename/delete/mkdir)**; EPUB generation from URL or custom text with direct upload; sleep-screen customization with image crop + widget overlays; device monitoring (firmware/RAM/IP/WiFi mode/orientation/theme); i18n (EN/UK/ES/DE). Talks WiFi HTTP + WebSocket over IP.
- **FIT (1): STRONG** — arguably the cleanest file-CRUD base, permissive license. **FIT (2): MODERATE** — sends images (sleep screen) and text-as-EPUB, but **no notes-as-message, no history, no collections**; you'd add the messenger layer.
- **License note:** Apache-2.0 — permissive, commercial-friendly, patent grant. Best choice if you want native Android/Kotlin and a permissive license.

### D. `shakogegia/xtlibre` — MIT — TypeScript (self-hosted) — 62★
- **Health:** Created 2026-03-26, last push 2026-04-07, 3 open issues, 4 forks. Most-starred of the companions.
- **What it is:** a **self-hosted server**, not a phone app. Converts EPUB → device-ready XTC, keeps a local library, **exposes it over OPDS**, and can push to a reader over WiFi.
- **FIT:** Not a fork base for the Android UI, but the **ideal backend** if your messenger needs **off-LAN/remote** delivery — run it as the OPDS/WebDAV source the reader pulls from, and have partner phones post into it. Fork-worthy for the server tier (MIT).

### E. Generic OPDS / reader apps (evaluated, NOT recommended as fork bases)
- **KOReader** (`koreader/koreader`) — **AGPL-3.0**, Lua, **28,000★+**, extremely active (pushed 2026-07-27). It is a full **reader**, not a transfer/manager companion — wrong shape and wrong size to fork for a lightweight companion. **Relevance:** CrossPoint implements **KOReader progress sync**, and KOReader natively does OPDS + Calibre-wireless receive. So it is a valuable **interop target** (reading-progress sync; an OPDS/Calibre transfer path), not a fork base.
- **Librera** — GPL-family, Java/Android reader with strong OPDS. Same conclusion: a reader, not a manager/sender; GPL copyleft; do not fork for this.
- **Calibre / Calibre-Web** — server-side library with OPDS + "Connect/Share → content server." Same role as XTLibre: a **pull backbone**, useful because the firmware speaks OPDS + Calibre-wireless, not something to fork for the phone UI.

---

## 4. Rankings

### Need (1) — HOST / EPUB manager (sideload, delete, organize, transfer)
1. **`inkcast-kmp` (Apache-2.0)** — if you want native Kotlin: cleanest full file-CRUD, permissive, production-ready, Android+iOS.
1. **`send-to-x4-mobile-app` (MIT)** — if RN/Expo is acceptable: file manager + EPUB/XTC + delete + CrossPoint support, and it doubles as the sender base (one codebase for both needs).
3. **`crosspoint-sync` (AGPL-3.0)** — most polished upload/discovery UX, but iOS-primary and copyleft; borrow ideas, don't fork for a private product.
- Backbone option: **`xtlibre` (MIT)** for an OPDS/library server tier; **KOReader/Calibre** as interop/transfer targets (device already pulls OPDS + Calibre-wireless).

### Need (2) — SENDER (photos + text notes, message history, trusted partners)
1. **`send-to-x4-mobile-app` (MIT)** — the only base that already sends **both photos and notes** and ingests images via share sheet. Add: message-history view, photo-as-message inbox, partner pairing/trust.
2. **`inkcast-kmp` (Apache-2.0)** — native Kotlin, sends images + text-as-EPUB; add notes-as-message, photo message model, and history.
3. **`crosspoint-sync` (AGPL-3.0)** — images-only, no notes/history, copyleft; weakest base for the messenger.

---

## 5. Fork-vs-build verdict

**Fork — specifically fork `Xatpy/send-to-x4-mobile-app` (MIT) as the foundation for the whole `xteink-messenger` (both needs in one app).** Reasoning:

1. **The expensive part already exists and works.** A correct CrossPoint client — multipart `POST /upload`, 64 KB WebSocket chunked upload on :81, file CRUD (`/mkdir`, `/rename`, `/move`, `/delete`, `/download`, `/api/files`), device discovery, EPUB packaging, and gallery-photo→480x800-BMP conversion — is precisely what these repos implement and what you'd otherwise spend weeks reverse-engineering for zero product differentiation.
2. **It already covers ~70% of both needs and explicitly supports CrossPoint** (not just Stock), so you inherit compatibility with the exact firmware in `firmware/crosspoint-reader/`.
3. **MIT lets you keep it private/commercial.** Your added "messenger" layer (message history, photo-as-message inbox, trusted-partner pairing) stays yours. This is the decisive advantage over the more-polished `crosspoint-sync`, whose **AGPL-3.0** would force full source disclosure.
4. **Cross-platform for free** (Android + iOS from one Expo/TS codebase) — matters for a "trusted partner devices" sender that partners will run on whatever phone they own.

**Choose `inkcast-kmp` (Apache-2.0) instead** only if native Kotlin/Compose is a hard requirement (no React Native): permissive, clean, Android+iOS, excellent file CRUD — you'd port more of the notes/photo-message features yourself.

**Build-fresh is only justified for the genuinely new part:** the messaging semantics (conversation history, photo-as-message, sender identity/trust) — layer these on top of a fork, don't rebuild the transport.

**One gap no existing app solves — plan for it:** every current app is **local-WiFi only** (push to the reader's LAN IP, or reader in AP mode). A true "partner sends a photo from anywhere" flow needs either same-LAN, AP-join, or a **reader-pull relay**. Because the firmware natively pulls **OPDS / WebDAV / Calibre-wireless**, the clean path is a small self-hosted relay the reader polls — and **`xtlibre` (MIT)** is a ready-made OPDS/library server you can fork for that backend tier.

---

## Appendix — every repo/link touched

- Firmware (upstream): https://github.com/crosspoint-reader/crosspoint-reader — MIT, C/C++ ESP32-C3, ~6.5k★
- Firmware (local copy in this project): `firmware/crosspoint-reader/` (HTTP+WS+WebDAV+OPDS server confirmed in `src/network/CrossPointWebServer.cpp`)
- BLE page-turner context: Discussion #117; local `freeink-sdk/libs/network/BleKeyboardHost/`, `freeink-sdk/docs/ble-keyboard-host.md`
- Send to X4 (app): https://github.com/Xatpy/send-to-x4-mobile-app · site https://www.chapiware.com/send-to-x4/ · Play `com.chapiware.sendtox4`
- CrossPoint Sync: https://github.com/zabirauf/crosspoint-sync · site https://crosspointsync.com/
- Inkcast (KMP): https://github.com/andrew-malitchuk/inkcast-kmp
- XTLibre: https://github.com/shakogegia/xtlibre
- KOReader: https://github.com/koreader/koreader
- Community hubs checked: https://www.readme.club/resources · https://einkhub.com/ · https://pocketink.io/ · GitHub topic https://github.com/topics/crosspoint
- `uxjulia/crossink`: firmware fork only ("Personal fork of Crosspoint"), not a companion app
