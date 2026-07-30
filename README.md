# Xteink Messenger

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**A private, two-person messenger that writes to an e-ink reader.**

This app sends short notes and photos from your phone to a CrossPoint-firmware Xteink reader over local Wi-Fi, rendered as an e-ink frame. No cloud, no cables, no accounts.

It is a fork of [Send to X4](https://github.com/Xatpy/send-to-x4-mobile-app), reshaped from a read-it-later utility into a messenger. The article/EPUB pipeline of the original has been removed.

> **⚠️ Disclaimer:** This is an independent, community-developed utility. It is **not** affiliated with or endorsed by Xteink. "Xteink" and "X4" are trademarks of their respective owners.

---

## 📱 The app

Five tabs. **Wallpaper** and **Device** are host-only — see Roles below.

| Tab | What it does | State |
|---|---|---|
| **Compose** | Write a note or pick a photo, render it to an e-ink frame, send it | Placeholder — owns the share intent; editor lands next |
| **History** | Outbox / message log with delivery status | Placeholder |
| **Wallpaper** | Send an image as the reader's permanent sleep screen | Working (adapted from the original screensaver flow) |
| **Device** | Browse and delete files on the reader | Working |
| **Settings** | Role, pairing, device host, folders | Working |

### Roles

Each install is either a **host** or a **client** (`Settings → This Device`).

- **Host** — physically paired with the reader over Wi-Fi. Owns permanent device state, so it is the only role that sees the Wallpaper and Device tabs.
- **Client** — has no direct reader access; it composes messages and hands them off. Wallpaper and Device are hidden.

The gate is `isHost()` in `src/services/role.ts`, pinned by `scripts/role.test.js`. Role is read from settings, which are an unversioned storage blob — anything unreadable falls back to a definite role rather than leaking host-only UI.

---

## ✨ Features

- **Share Sheet Integration** — Share text or an image from any app; it routes to Compose.
- **Direct Wi-Fi Transfer** — Chunked WebSocket upload straight from phone to reader. No cloud, no logging.
- **Sleep Screen / Wallpaper Upload** — Send any gallery image as the reader's sleep screen.
- **Device File Manager** — Browse and delete files on the reader from the app.
- **Connection Status** — Continuous reachability probe with an actionable banner, re-checked on foreground.

---

## 🛡️ Privacy

This app is built with a **privacy-first** architecture:

- All processing happens locally on your device
- No analytics, no tracking SDKs, no cloud storage
- Files transfer directly over your local Wi-Fi network

---

## 📹 Demo

![demo](./media/send-to-x4.gif)


---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20.x
- [Expo CLI](https://docs.expo.dev/get-started/installation/)
- iOS: Xcode 15+ and CocoaPods
- Android: Android Studio with SDK 36+

### Installation

```bash
# Clone the repository
git clone https://github.com/Xatpy/send-to-x4-mobile-app.git
cd send-to-x4-mobile-app

# Use the supported Node.js version
nvm use

# Install dependencies
npm install

# Generate native projects from your own identifiers
npx expo prebuild --clean

# Run on iOS
npx expo run:ios

# Run on Android
npx expo run:android
```

### Development Server

```bash
npx expo start
```

### Running Tests

```bash
# Typecheck — the only type gate (the test runner is transpile-only)
npm run typecheck

# Run all tests (node --test over scripts/*.test.js)
npm run test:all

# A single suite
node --import tsx --test scripts/folder-sanitize.test.js
```

Tests are Node's built-in runner with `tsx` as the TypeScript loader, importing `src/**/*.ts` directly — no bundler, no React Native mocking. A new `scripts/*.test.js` file is picked up by the glob automatically; no config change needed.

---

## 🏗️ Project Structure

```
send-to-x4-mobile-app/
├── App.tsx                     # Entry point; tab + stack nav, share-intent routing
├── src/
│   ├── components/             # Reusable UI (banner, buttons, status, queue list)
│   ├── contexts/               # ConnectionProvider (settings + reachability), ProgressProvider
│   ├── screens/                # Compose, History, Wallpaper, Device, Settings
│   ├── services/               # Transport, encoders, senders, settings, role
│   ├── types/                  # Shared TypeScript types
│   └── utils/                  # base64, lock, sanitizer
├── scripts/                    # Tests and build utilities
├── plugins/                    # Custom Expo config plugins
├── assets/                     # App icons and splash screen
└── docs/                       # Product documentation
```

---

## 🔧 How It Works

1. **Compose or share** a note or photo into the app
2. It is **rendered and encoded** to the frame format the reader's firmware expects
3. The frame is **transferred over local Wi-Fi** to the reader — HTTP on `:80` for listing and mkdir, chunked WebSocket on `:81` for the upload itself
4. The reader **displays it** on its e-ink panel

The app targets `crosspoint.local` by default and relies on the OS resolving it over the shared LAN; the host is configurable in Settings.

---

## 📝 EAS Project Configuration

This project uses [Expo EAS](https://expo.dev/eas) for builds. Build-time identifiers are read from environment variables via `app.config.ts`.

1. Copy `.env.example` to `.env`
2. Create a free Expo account at [expo.dev](https://expo.dev)
3. Run `eas init` to create your own project
4. Set `EAS_PROJECT_ID` in `.env`
5. Set your bundle ID values (`APP_BUNDLE_ID`, `APP_IOS_APP_GROUP`) in `.env`

Notes:

- The checked-in `ios/` and `android/` folders are development artifacts. Regenerate them with `npx expo prebuild --clean` after setting `.env` so your local bundle identifiers, app group, and signing settings are applied consistently.
- CI and local tests are supported on Node 20.x. Newer Node majors may fail on tooling transforms outside the app runtime.

---

## 🤝 Contributing

Contributions are welcome! Whether it's bug reports, feature requests, or code contributions:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/my-feature`)
3. **Commit** your changes (`git commit -m 'Add my feature'`)
4. **Push** to the branch (`git push origin feature/my-feature`)
5. **Open** a Pull Request

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](./LICENSE) file for details.

---

## 📬 Contact

- **Website:** [chapiware.com/send-to-x4](https://chapiware.com/send-to-x4)
- **Email:** [hi@chapiware.com](mailto:hi@chapiware.com)
