# CrossPoint Reader Firmware — Fork Assessment (Xteink X3 BLE photo/note receiver)

READ-ONLY assessment. No firmware code was modified. Clone location:
`C:/Users/Donovan/xteink-messenger/firmware/crosspoint-reader`

**Fork verdict: GREEN. Fork it.** The firmware is a clean, well-layered C++/Arduino/PlatformIO
codebase with an Android-style Activity stack, a HAL over storage/display, a ready-made
full-screen message activity, an atomic SD file-write pattern already in `main.cpp`, and a
NimBLE integration blueprint in the SDK. It ships **no BLE** today, but the SDK's
`BleKeyboardHost` gives us the exact NimBLE init/teardown/capability-gating pattern to copy for
a new GATT **peripheral** (server) service.

---

## 1. Repo facts

- **HEAD commit:** `99c0e504bd401a06128c126aa0b42f3ec524c05b` (shallow `--depth 1`, tip of default branch).
- **Latest release tag:** `1.5.0` (remote tags run 0.2.0 → 1.5.0; `platformio.ini [crosspoint] version = 1.5.0`). Newest remote tag observed: `1.5.0`.
- **Submodule:** `freeink-sdk` (github.com/Free-Ink/freeink-sdk) pinned at `ae68356de994a536dd6c45615a42ea485b3dddca`. Not fetched by the shallow clone — I ran `git submodule update --init --depth 1 freeink-sdk` to analyze the HAL/BLE/display libs.
- **Size:** ~70 MB working tree (`.git` = 25 MB) before submodule; freeink-sdk adds more.
- **Language:** C++ (`-std=gnu++2a`, `-fno-exceptions`) for firmware; Python for build/codegen scripts (`scripts/*.py`); Nix for the dev shell.

## 2. Build system

- **PlatformIO + Arduino framework** on the **pioarduino** fork of platform-espressif32 (`platformio.ini:10`). Board `esp32-c3-devkitm-1` (`platformio.ini:11`), 16 MB flash, upload offset `0x10000`.
- **Build/flash the X3:** `pio run -e default -t upload` (dev) or `pio run -e gh_release -t upload` (release). Envs (`platformio.ini:151-207`):
  - `default` — dev, `-DFREEINK_DEVICE_X3=1 -DFREEINK_DEVICE_X4=1`, debug logs (`LOG_LEVEL=2`).
  - `gh_release` / `gh_release_rc` — release (`LOG_LEVEL=1`).
  - `slim` — serial logging stripped to save space.
  - `sticky` — a different MCU (ESP32-S3), not relevant to X3.
  - **There is no separate `-e x3` env.** The C3 envs build **one dual-target binary** for X3 **and** X4 and auto-detect the panel at runtime (`main.cpp:296` `gpio.deviceIsX3()`; the display driver keys off `FREEINK_DEVICE_X3`). So `-e default` already targets the X3.
- **Simulator: NONE.** No native/desktop/SDL env exists. What you get instead:
  - **Host unit tests** in `test/` (CMake/GoogleTest-style, registered by `scripts/register_unit_tests_target.py`; run via `pio test` or the generated target). These are logic tests, not a device sim.
  - **Serial screenshot capture** — `loop()` answers a `CMD:SCREENSHOT` serial command by dumping the raw framebuffer (`main.cpp:483-489`), consumed by `scripts/debugging_monitor.py`.
- **Nix dev-shell:** flake at `nix/flake.nix` (`nix develop ./nix`), plus `nix/shell.nix` + `nix/default.nix` (flake-compat). It builds an FHS env + a `uv` venv that installs pioarduino PlatformIO Core 6.1.19 and `requirements.txt`, and exposes a `pio` wrapper. `PLATFORMIO_CORE_DIR` is pinned under `.cache/platformio`.

## 3. BLE — current state and reusability

- **The shipped firmware has NO BLE.** `src/`/`lib/` reference no NimBLE/Bluedroid/BLE server code (grep for `NimBLE|BleHid|esp_ble` in `src` is empty). `platformio.ini:148-149` even sets `lib_ignore = BLE` (excludes the Arduino Bluedroid "BLE" lib). The "page turn" grep hits are all EPUB page-turning, not Bluetooth.
- **The SDK provides a NimBLE blueprint:** `freeink-sdk/libs/network/BleKeyboardHost/` — a **central-role HID host** (connects to keyboards/page-turner remotes), **capability-gated** by `FREEINK_CAP_BLE_HID_HOST` (default **off**, `BoardConfig.h:164-170`). Stack = **NimBLE-Arduino** (`h2zero/NimBLE-Arduino@^2.3.8`, deliberately *not* declared in the lib so disabled builds link zero BLE code — you add it to firmware `lib_deps` when enabling; see `library.json`).
- **Structure worth copying** (`freeink-sdk/libs/network/BleKeyboardHost/`):
  - Singleton, NimBLE-free public header (`include/BleKeyboardHost.h`) so callers never pull in the stack; real vs stub bodies via `#if FREEINK_CAP_BLE_HID_HOST` (`src/BleKeyboardHost.cpp:23`).
  - `begin()` — `NimBLEDevice::init()` (`.cpp:354`), `NimBLEDevice::setMTU(23)` (`.cpp:363`). **Bump MTU for frame transfer** (e.g. 247) in our version.
  - `end()` — `NimBLEDevice::deinit(true)` (`.cpp:474`) returns "tens of KB" of host+controller RAM to the heap. **This is the RAM-reclaim seam we need before EPUB rendering.**
  - Fixed-capacity buffers + a spinlock-guarded ring drained from the main loop (`popKey()`), no heap in the hot path — a good model for a chunk-ingest queue.
- **Reusability for a chunked frame service (BEGIN/CHUNK/COMMIT/ACK):** *Partial.* The lib is **central/observer** (scan → connect → subscribe). Our feature needs the **peripheral/GATT-server** role (`NimBLEDevice::createServer` / `createService` / `createCharacteristic` / advertising) which this lib does **not** implement. **We write a new peripheral service**, but reuse: (a) the capability-gating + header-isolation pattern, (b) the `init()`/`setMTU()`/`deinit(true)` lifecycle, (c) the ring-buffer-to-main-loop hand-off. Suggested GATT layout: one service with a control characteristic (write: BEGIN{len,crc}/COMMIT), a data characteristic (write-no-response: CHUNK), and a status characteristic (notify: ACK/NAK/progress).

## 4. SD / filesystem

- **HAL:** `lib/hal/HalStorage.h`, singleton macro `Storage` (`HalStorage.h:59`). Backed by SdFat (note `-DUSE_UTF8_LONG_NAMES=1`, `FsApiConstants.h`/`oflag_t`). `HalFile` is a `Print`-derived handle (`HalStorage.h:61-97`).
- **APIs we need are all present:**
  - Dir: `Storage.mkdir(path, pFlag=true)` (`:34`), `ensureDirectoryExists()` (`:31`), `exists()` (`:35`).
  - Open: `Storage.openFileForWrite("MOD", path, HalFile&)` (`:43-45`), `openFileForRead(...)` (`:40-42`).
  - I/O: `HalFile::write(const void*, count)` (`:88`), `read(void*, count)` (`:86`), `close()` (`:93`).
  - **Atomic rename:** `Storage.rename(oldPath, newPath)` (`:37`) **or** `HalFile::rename(newPath)` (`:90`); plus `Storage.remove()` (`:36`).
- **Copy this exact pattern** — `main.cpp:171-192` already does chunk-write + read-back + cleanup for the sleep frame:
  ```cpp
  constexpr char SLEEP_FRAME_FILE[] = "/.crosspoint/sleep_frame.bin";
  Storage.openFileForWrite("SLP", SLEEP_FRAME_FILE, file);
  file.write(renderer.getFrameBuffer(), renderer.getBufferSize());  // one shot; loop per CHUNK for us
  file.close();
  ```
- **Where our writes go:** create `/.love-notes/` (`Storage.mkdir`), stream CHUNKs to `/.love-notes/incoming.tmp` via `openFileForWrite` + repeated `file.write`, `close()` on COMMIT, validate (size + CRC), then `Storage.rename("/.love-notes/incoming.tmp", "/.love-notes/current.frame")` for the atomic swap.

## 5. Display / render

- **HAL:** `lib/hal/HalDisplay.h`, global `display` (`HalDisplay.h:105`); higher-level `GfxRenderer` (`lib/GfxRenderer/GfxRenderer.h`), global `renderer` (`main.cpp:38`).
- **X3 panel = 792×528 native (528×792 portrait), 1-bit.** `FreeInkDisplay.h:51-54`: `X3_DISPLAY_WIDTH=792`, `X3_DISPLAY_HEIGHT=528`, `X3_BUFFER_SIZE = (792/8)*528 = 52272 bytes (~51 KB)`. Single-buffer mode (`-DEINK_DISPLAY_SINGLE_BUFFER_MODE=1`, `platformio.ini:29`).
- **Blit a raw 1-bit buffer:**
  - Direct: `display.getFrameBuffer()` (`HalDisplay.h:59`) / `renderer.getFrameBuffer()` (`GfxRenderer.h:333`) + `getBufferSize()` — `memcpy` a full 52272-byte frame in, then refresh. This is exactly what `loadSleepFrameBuffer()` does (`main.cpp:180-192`).
  - Positioned: `HalDisplay::drawImage(imageData, x, y, w, h, fromProgmem)` (`HalDisplay.h:36`) / `renderer.drawImage(bitmap, x, y, w, h)` (`GfxRenderer.h:226`) — respects renderer rotation/orientation; use `(0,0,528,792)` for a full-screen note.
- **Refresh / partial-refresh calls:** `RefreshMode { FULL_REFRESH, HALF_REFRESH, FAST_REFRESH }` (`HalDisplay.h:14-18`). Blit-to-panel = `renderer.displayBuffer(mode)` (`GfxRenderer.h:167`) → `display.displayBuffer()` (`HalDisplay.h:41`). Async/partial variants: `displayBufferAsync()` + `waitRefreshComplete()` (`HalDisplay.h:47-49`). For a photo/note use **`FULL_REFRESH`** (best ghost-free quality).
- **Where a static message screen hooks:** `src/activities/util/FullScreenMessageActivity.cpp:7-16` is the template — `renderer.clearScreen()` → draw → `renderer.displayBuffer(refreshMode)`. Launched via `activityManager.goToFullScreenMessage(msg, style)` (`ActivityManager.h:92`; used at `main.cpp:303`).

## 6. Startup / wake + sleep

- **Boot flow — `src/main.cpp:setup()` (263-457):** `holdPowerRails` → Serial → `HalSystem::begin` → `gpio/powerManager/tilt/clock begin` → device detect (`:296`) → **`Storage.begin()` (`:300`)** → **`SETTINGS.loadFromFile()` + other stores (`:309-315`)** → resolve wakeup reason (`:318-337`) → recovery-mode check (`:339-356`) → boot-presentation resolve (`:365-406`) → **activity routing (`:408-435`)** → optional block-until-first-paint (`:437-452`).
- **Insert the bounded BLE advertise+sync phase HERE:** right after settings load (`main.cpp:309`) and **before** the routing block (`main.cpp:359`). Gate on `SETTINGS.messageSyncEnabled`, run NimBLE peripheral with a `millis()` deadline; on timeout / no client, fall through to the existing routing untouched (safe fallback). If a frame arrives, render it via a message activity; on dismiss, continue to normal routing. Deinit BLE (below) before proceeding.
- **Deep sleep entry — `enterDeepSleep()` (`main.cpp:195-228`):** power lock → save state → tear down current activity → optional sleep-frame save → WiFi off → `display.deepSleep()` → `powerManager.startDeepSleep(gpio)` (never returns). Auto-sleep fires from `loop()` at `main.cpp:526-531`; power-button sleep at `:533-542`.
- **BLE RAM reclaim before EPUB rendering:** call `NimBLEDevice::deinit(true)` (mirror `BleKeyboardHost::end()`, `BleKeyboardHost.cpp:474`) at the end of the sync phase — returns tens of KB to the heap before the reader's EPUB inflate. **Must run at normal CPU frequency** (controller deinit), same constraint the SDK notes for `begin()`/`end()`.

## 7. Settings system

- **Storage:** `src/CrossPointSettings.h` — a `PersistableStore<CrossPointSettings>` singleton (macro `SETTINGS`) persisted as JSON at `/.crosspoint/settings.json` (`:345`), each option a `uint8_t` field. Loaded at `main.cpp:309`.
- **UI/registration:** options declared in `getSettingsList()` (`src/SettingsList.h:191`), typed `SettingInfo` (`src/activities/settings/SettingsActivity.h:30-151`), types `TOGGLE/ENUM/ACTION/VALUE/STRING`. TOGGLEs with a `valuePtr`+`key` persist automatically (generic save/load loop).
- **Add a "message sync" toggle (3 edits):**
  1. `CrossPointSettings.h` — add `uint8_t messageSyncEnabled = 1;` (near other flags ~`:282`).
  2. `SettingsList.h` — add to the `System` block (~`:305`): `SettingInfo::Toggle(StrId::STR_MESSAGE_SYNC, &CrossPointSettings::messageSyncEnabled, "messageSync", StrId::STR_CAT_SYSTEM)` (pattern matches `:233`, `:300`).
  3. i18n — add `StrId::STR_MESSAGE_SYNC` (via `scripts/gen_i18n.py` source strings). Read it in the boot phase as `SETTINGS.messageSyncEnabled`.

## 8. Smallest concrete seam list

### Milestone 1 — static 528×792 message screen + dismiss returns to reading
1. **New activity** `src/activities/util/MessageDisplayActivity.{h,cpp}` — model on `FullScreenMessageActivity` (`src/activities/util/FullScreenMessageActivity.cpp:7-16`), but subclass `Activity` (`src/activities/Activity.h:16`) and add:
   - `onEnter()`: load `/.love-notes/current.frame` into `renderer.getFrameBuffer()` (like `loadSleepFrameBuffer`, `main.cpp:180-192`) **or** `renderer.drawImage(buf,0,0,528,792)` (`GfxRenderer.h:226`), then `renderer.displayBuffer(HalDisplay::FULL_REFRESH)` (`GfxRenderer.h:167`, enum `HalDisplay.h:14-18`).
   - `loop()` (override `Activity::loop()`, `Activity.h:33`): on `mappedInput.wasReleased(Back/Confirm)` call `finish()` (`Activity.h:61`) to pop back to the reader.
2. **Launcher** on `ActivityManager` — add `goToMessage()` mirroring `goToFullScreenMessage` (`ActivityManager.h:92`, impl in `ActivityManager.cpp`). Use `pushActivity()` (`ActivityManager.h:97`) so the reader stays on the stack and `finish()` returns to it (vs `replaceActivity()` which drops the stack, `ActivityManager.h:81`).
3. **Framebuffer anchors:** `HalDisplay::getFrameBuffer()` (`HalDisplay.h:59`), `BUFFER_SIZE`=52272 (`HalDisplay.h:32` / `FreeInkDisplay.h:54`), `drawImage` (`HalDisplay.h:36`), `displayBuffer(FULL_REFRESH)` (`HalDisplay.h:41`).

*(M1 can be exercised with no BLE at all by dropping a 52272-byte 1-bit file at `/.love-notes/current.frame` on the SD card and launching the activity.)*

### Milestone 2 — wake-time BLE GATT receive → SD → validate → render → ACK
1. **New NimBLE peripheral lib** (copy structure of `freeink-sdk/libs/network/BleKeyboardHost/`): capability-gated singleton, NimBLE-free header. Implement GATT server (`createServer`/`createService`/`createCharacteristic`/advertising) + BEGIN/CHUNK/COMMIT/ACK. Lifecycle from `BleKeyboardHost.cpp`: `NimBLEDevice::init()` (`:354`), `setMTU(≥247)` (cf. `:363`), `NimBLEDevice::deinit(true)` (`:474`).
2. **Boot hook:** insert bounded phase in `src/main.cpp:setup()` after `SETTINGS.loadFromFile()` (`:309`), before routing (`:359`); gate on `SETTINGS.messageSyncEnabled`; `millis()` deadline with fall-through to existing routing on timeout.
3. **SD sink:** `Storage.mkdir("/.love-notes")` (`HalStorage.h:34`) → `openFileForWrite("MSG","/.love-notes/incoming.tmp",file)` (`:43`) → per-CHUNK `file.write()` (`:88`) → `close()` on COMMIT → validate → `Storage.rename(incoming.tmp, current.frame)` (`:37`). Model: `main.cpp:171-192`.
4. **Render + ACK:** load `current.frame` → `renderer.getFrameBuffer()` + `displayBuffer(FULL_REFRESH)`; notify status characteristic with ACK; `NimBLEDevice::deinit(true)` to reclaim RAM before the reader loads.
5. **Toggle:** section 7 edits.
6. **Build wiring:** add `h2zero/NimBLE-Arduino@^2.3.8` to `platformio.ini lib_deps` (`:128-146`) and set the capability define; keep `lib_ignore = BLE` (that excludes Arduino Bluedroid, which must NOT co-link with NimBLE).

## 9. Gotchas

- **Partition layout (`partitions.csv`):** 16 MB flash, **dual OTA** `app0`/`app1` each `0x640000` = **6.5 MB** app slots, `spiffs` 3.5 MB, `coredump` 64 KB, `nvs` 20 KB. NimBLE adds tens of KB of flash — fits easily. Flash is not the constraint; **RAM is.**
- **RAM coexistence (the real risk):** ESP32-C3 ~380 KB, and `platformio.ini:46-53` notes a reading session leaves only **~50 KB free heap**. The framebuffer is ~51 KB (single-buffer). The NimBLE host+controller costs tens of KB. **BLE and EPUB rendering must not be resident at once** — run the BLE sync phase at wake, fully `NimBLEDevice::deinit(true)` before the reader inflates. The firmware already fights for heap (custom `sdkconfig` reclamation, `CONFIG_ESP_WIFI_IRAM_OPT=n`, task-stack right-sizing at `:82-104`); enabling the BLE controller partially reverses that, so budget NimBLE buffer counts via `custom_sdkconfig`. `HalDisplay::lendFrameBufferStorage()` (`HalDisplay.h:66`) exists to loan the 51 KB during memory-hungry phases — useful during the transfer if the frame streams straight to SD.
- **`lib_ignore = BLE` (`platformio.ini:149`):** ignores the Arduino **Bluedroid** BLE lib. Use **NimBLE-Arduino** (not esp32 BLE, not esp-nimble-cpp) — leaving the ignore in place avoids a double controller-init link conflict.
- **OTA / update paths:** WiFi OTA (`OtaUpdateActivity`), SD-card `.bin` update (`SdFirmwareUpdateActivity`), and a **recovery mode** — hold **UP + POWER at boot** jumps straight to the SD firmware picker (`main.cpp:339-356`, `:408-411`). This is the bootloop escape hatch for a bad flash (some X3 units have USB flashing locked down).
- **Bootloop guards:** panic → `CrashActivity` (`main.cpp:412`); `readerActivityLoadCount` guard clears a failing open-book so a bad EPUB can't loop (`main.cpp:423-435`); RTC "silent reboot" magic for heap-defrag restarts (`main.cpp:116-161, 285-289`). Our wake-BLE phase must be timeout-bounded and side-effect-free on failure so it can never strand boot.
- **Single-buffer display mode:** one shared framebuffer; the message frame overwrites whatever the reader had, and the reader must repaint on return (expected — `finish()` re-renders the underlying activity).
- **Orientation:** the X3 is native 792×528 landscape; the renderer works in logical/portrait coords with rotation. A raw memcpy into `getFrameBuffer()` writes panel-native bytes (no rotation); `renderer.drawImage()` applies the renderer transform. Pick one convention for the sender and stay consistent.
