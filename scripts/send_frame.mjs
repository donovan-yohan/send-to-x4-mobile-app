#!/usr/bin/env node
/**
 * send_frame.mjs — devbox uploader for Xteink X3 love-note frames.
 *
 * Purpose: let M1 ("prove the pipe") run WITHOUT building/sideloading the phone
 * app. This is a byte-faithful port of the app's CrossPoint transport:
 *   src/services/crosspoint_upload.ts
 *     - ensureFolderExistsCrossPoint()  :240-297   (GET /api/files + POST /mkdir)
 *     - uploadViaWebSocket()            :53-173    (ws://host:81 chunked upload)
 *   src/services/settings.ts
 *     - normalizeDeviceHost()           :76-83
 *     - getDeviceBaseUrl()              :95-97     (http://<host>, port 80)
 *
 * Every protocol constant below carries the crosspoint_upload.ts line it came
 * from so a reviewer can diff this against the app. Quirks are copied on
 * purpose and flagged with "QUIRK:".
 *
 * DELETE BEFORE UPLOAD (default; hardware-proven 2026-07-28). The firmware
 * refuses to overwrite an existing path — it answers `ERROR: File already
 * exists` and writes nothing. `/.love-notes/current.frame` is a single fixed
 * slot that gets re-sent every time, so without a delete the SECOND send always
 * fails, while the reader still shows the FIRST note. `POST /delete` (form
 * fields path + type, crosspoint_upload.ts:386-413) therefore runs first, and
 * `--no-delete` opts out for diagnosing the firmware's overwrite behaviour.
 *
 * TWO FILES, IN THIS ORDER (default). A note is a frame PLUS the id sidecar the
 * firmware dedups on, `/.love-notes/current.id` (crosspoint-reader
 * src/network/MessageSync.cpp:19 `CURRENT_ID`):
 *
 *   - NO ID => "legacy / id-less frame", `MessageSync::hasUnreadNote`
 *     (MessageSync.cpp:114-119) answers true forever and
 *     `markCurrentNoteShown` (:121-128) has nothing to record, so the reader
 *     re-displays the note on EVERY wake.
 *   - ID BEFORE ITS FRAME => the reader shows the frame it already has and marks
 *     the NEW id as shown, so the note actually being sent is deduped away and
 *     never appears. Strictly worse than no id, which is why the frame is
 *     uploaded first and a failed frame upload stages no id at all.
 *   - A STALE ID SURVIVING A SEND => it still equals `messageLastShownId`, so the
 *     fresh frame under it is never shown. Hence `current.id` is cleared on every
 *     send, including under `--no-id`.
 *
 * The bytes are the bare id, ASCII, no trailing newline — byte-identical to the
 * mailbox route's `Storage.writeFile(CURRENT_ID, ...)` (MessageSync.cpp:197).
 * `trimId` (MessageSync.cpp:36-43) would tolerate a trailing newline but NOT a
 * leading one, so nothing is padded. `--id` pins the id, `--no-id` writes the
 * legacy id-less frame for diagnosing the re-show behaviour deliberately. Both
 * are skipped when `--name` is not `current.frame`: an id sidecar next to a frame
 * stored under some OTHER name would describe a note that is not there.
 *
 * Usage:
 *   node scripts/send_frame.mjs <file> [--host crosspoint.local] [--path /.love-notes]
 *                               [--name current.frame] [--verify] [--dry-run] [--force]
 *                               [--no-delete] [--id <id> | --no-id]
 *   node scripts/send_frame.mjs --self-test      # offline protocol test, no hardware
 *
 * Exit codes: 0 ok | 1 upload/protocol failure | 2 usage/validation | 3 unreachable
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Protocol constants — all mirrored from src/services/crosspoint_upload.ts
// ---------------------------------------------------------------------------

/** 528 rows x 99 bytes/row, 1 bit/px, 792 px wide. Device contract, not app code. */
const FRAME_BYTES = 52272;

const WS_PORT = 81;                          // crosspoint_upload.ts:61  `ws://${ip}:81/`
const HTTP_PORT = 80;                        // settings.ts:96          `http://${host}`
const CHUNK_SIZE = 4096;                     // crosspoint_upload.ts:87
const MAX_IN_FLIGHT = 128 * 1024;            // crosspoint_upload.ts:67  128KB unacked window
const ACK_FALLBACK_MS = 1000;                // crosspoint_upload.ts:98-103 missed-PROGRESS escape
const YIELD_EVERY_BYTES = CHUNK_SIZE * 4;    // crosspoint_upload.ts:113 yield every 16KB
const YIELD_MS = 10;                         // crosspoint_upload.ts:114
const UPLOAD_TIMEOUT_MS = 300000;            // crosspoint_upload.ts:31  TIMEOUT_MS (5 min)
const LIST_TIMEOUT_MS = 5000;                // crosspoint_upload.ts:252
const MKDIR_TIMEOUT_MS = 10000;              // crosspoint_upload.ts:278
const DELETE_TIMEOUT_MS = 10000;             // crosspoint_upload.ts:391
const VERIFY_TIMEOUT_MS = 10000;             // crosspoint_upload.ts:363
/** CLI-only: the app has no separate handshake deadline, it just waits out TIMEOUT_MS. */
const HANDSHAKE_TIMEOUT_MS = 10000;
/** Give the firmware a beat to close/rename the file before re-listing it. */
const VERIFY_SETTLE_MS = 300;

const DEFAULT_HOST = 'crosspoint.local';     // settings.ts:7  DEFAULTS.crossPointIp
const DEFAULT_DEVICE_PATH = '/.love-notes';
const DEFAULT_NAME = 'current.frame';
/** MessageSync.cpp:19 CURRENT_ID — the sidecar the firmware dedups on. */
const DEFAULT_ID_NAME = 'current.id';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_UNREACHABLE = 3;

// ---------------------------------------------------------------------------
// Note ids — ported from src/services/mailbox_client.ts, bounded by the firmware
// ---------------------------------------------------------------------------

/**
 * MessageSync.cpp:34 `MAX_ID_LEN`. `trimId` (MessageSync.cpp:36-43) applies it as
 * a silent `resize()`, so an over-long id is TRUNCATED, never rejected: the
 * reader would then dedup on a string this tool never printed.
 */
const NOTE_ID_MAX_CHARS = 128;

/**
 * Charset an id may use. Wider than what the minter emits ([0-9a-z-]) because
 * `--id` accepts an id from elsewhere; the exclusions are what matter. Whitespace
 * is out because `trimId` strips some of it and not the rest (trailing \n \r space
 * tab, but only LEADING space and tab), so a whitespace-bearing id can compare
 * equal to a different id on the device. `/` is out because the sidecar is written
 * by filename, not by path. Same rule as love_note_sender.ts's NOTE_ID_ALLOWED.
 */
const NOTE_ID_ALLOWED = /^[A-Za-z0-9._~-]+$/;

/** mailbox_client.ts:169-179 — the minter's field widths, kept identical. */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_TIME_CHARS = 9;
const ID_SEQ_CHARS = 3;
const ID_SEQ_MASK = 0xfff;
const ID_RANDOM_CHARS = 8;

let idSequence = Math.floor(Math.random() * (ID_SEQ_MASK + 1));

/**
 * Port of `mintNoteId` (mailbox_client.ts:210-219), NOT a re-invention: the app
 * and this tool write into the same slot on the same card, and a history row has
 * to look the same whichever one produced it. Sortable base-36 millisecond, then
 * an in-process sequence so a burst inside one tick cannot collide even with a
 * badly seeded RNG, then random padding.
 */
function mintNoteId() {
    const now = Date.now();
    const millis = Number.isFinite(now) && now > 0 ? Math.floor(now) : 0;
    const time = millis.toString(36).padStart(ID_TIME_CHARS, '0').slice(-ID_TIME_CHARS);
    idSequence = (idSequence + 1) & ID_SEQ_MASK;
    const seq = idSequence.toString(36).padStart(ID_SEQ_CHARS, '0');
    let random = '';
    for (let i = 0; i < ID_RANDOM_CHARS; i++) {
        random += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    return `${time}-${seq}${random}`;
}

/**
 * Why `id` cannot be staged, or null when it can — love_note_sender.ts's
 * `describeNoteIdProblem`, same rules. Checked before any network call: an id
 * rejected AFTER the frame landed would leave the reader in exactly the id-less
 * state the sidecar exists to end.
 */
function describeNoteIdProblem(id) {
    if (typeof id !== 'string' || !id) return 'note id is empty';
    if (id.length > NOTE_ID_MAX_CHARS) {
        return `note id is ${id.length} characters; the reader truncates at ${NOTE_ID_MAX_CHARS} (MessageSync.cpp MAX_ID_LEN)`;
    }
    if (!NOTE_ID_ALLOWED.test(id)) return `note id must match [A-Za-z0-9._~-] (got '${id}')`;
    return null;
}

function reachHint(host) {
    return [
        'Check that:',
        '  * the reader is AWAKE (it drops WiFi in deep sleep) — wake it, then retry',
        `  * it is on this LAN:  ping ${host}   (or pass --host <ip>)`,
        "  * or join the reader's own AP 'CrossPoint-Reader' and use --host 192.168.4.1",
        `  * nothing is firewalling HTTP :${HTTP_PORT} / WebSocket :${WS_PORT} on this box`,
    ].join('\n');
}

/** Human-facing names for the internal stage ids. */
const STAGE_LABEL = {
    delete: 'pre-upload delete (POST /delete)',
    mkdir: 'folder setup (GET /api/files + POST /mkdir)',
    upload: 'websocket upload',
    'upload-id': `id sidecar upload (${DEFAULT_ID_NAME})`,
    verify: 'post-upload verify',
    'verify-id': 'post-upload verify (id sidecar)',
};

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Host / path helpers (ported from settings.ts)
// ---------------------------------------------------------------------------

/** settings.ts:76-83 — accepts bare hosts, strips accidental scheme/path. */
function normalizeDeviceHost(value) {
    const trimmed = String(value).trim();
    if (!trimmed) return '';
    let host = trimmed.replace(/^https?:\/\//i, '');
    host = host.split('/')[0];
    return host;
}

/** settings.ts:95-97 — device HTTP base. httpPort is 80 in the app; overridable for --self-test. */
function deviceBaseUrl(host, httpPort = HTTP_PORT) {
    return httpPort === 80 ? `http://${host}` : `http://${host}:${httpPort}`;
}

/**
 * crosspoint_upload.ts:242 — folder is split on '/' with empties dropped, then
 * each level is ensured under its parent. The app then hands
 * `/${targetFolder}` to the WS START line (crosspoint_upload.ts:190), which for a
 * nested folder equals '/' + segments.join('/').
 */
function folderSegments(devicePath) {
    return String(devicePath).split('/').filter(Boolean);
}

function deviceTargetPath(devicePath) {
    const segs = folderSegments(devicePath);
    return segs.length ? `/${segs.join('/')}` : '/';
}

/**
 * Absolute device path of the uploaded file, as `POST /delete` wants it.
 * crosspoint_upload.ts:389 builds `/${targetFolder}/${filename}`, which for the
 * love-note folder is exactly `/.love-notes/current.frame`. The root case is
 * special-cased so an empty folder cannot emit a doubled `//name`.
 */
function deviceFilePath(devicePath, name) {
    const target = deviceTargetPath(devicePath);
    return target === '/' ? `/${name}` : `${target}/${name}`;
}

/** crosspoint_upload.ts:20-26 */
function safeDecodeURIComponent(str) {
    try {
        return decodeURIComponent(str);
    } catch {
        return str;
    }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function errorCode(err) {
    return err?.cause?.code ?? err?.code ?? null;
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const CONNECT_CODES = new Set([
    'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
    'ECONNRESET', 'EHOSTDOWN', 'EPIPE', 'ENETDOWN', 'EADDRNOTAVAIL',
]);

/** -> { kind: 'dns'|'connect'|'timeout'|'other', message } */
function classifyNetworkError(err, what) {
    const code = errorCode(err);
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        return { kind: 'timeout', message: `${what}: timed out` };
    }
    if (DNS_CODES.has(code)) {
        return { kind: 'dns', message: `${what}: cannot resolve host (${code})` };
    }
    if (CONNECT_CODES.has(code)) {
        return { kind: 'connect', message: `${what}: ${code}` };
    }
    const detail = err?.message ? String(err.message) : String(err);
    return { kind: 'other', message: `${what}: ${detail}${code ? ` (${code})` : ''}` };
}

/**
 * "The reader is not there" — as opposed to "the reader is there but slow/odd".
 *
 * DELIBERATELY excludes 'timeout'. The app swallows every folder-setup failure
 * (crosspoint_upload.ts:265-268 for the list, :288-291 for mkdir) and uploads
 * anyway; a busy ESP32-C3 doing an SD directory listing during an e-ink refresh
 * can blow past the 5s list deadline on a device that accepts the upload fine.
 * Treating that as "unreachable" would report a working device as unplugged,
 * which is the single most misleading thing this tool could say. Only DNS and
 * connect-level failures (ENOTFOUND / ECONNREFUSED / EHOSTUNREACH / ...) are
 * fatal here — those are unambiguous and worth the fast, specific error.
 */
function isUnreachable(kind) {
    return kind === 'dns' || kind === 'connect';
}

// ---------------------------------------------------------------------------
// multipart/form-data body — replicates what RN's FormData -> okhttp emits
// ---------------------------------------------------------------------------

/**
 * crosspoint_upload.ts:273-285 builds `new FormData()` with string fields
 * `name` and `path` and posts it to /mkdir. On Android that goes through okhttp's
 * MultipartBody, which emits, per string part:
 *
 *   --<boundary>CRLF
 *   Content-Disposition: form-data; name="<field>"CRLF
 *   Content-Length: <utf8 byte length>CRLF        <- okhttp adds this for sized bodies
 *   CRLF
 *   <value>CRLF
 *   ...
 *   --<boundary>--CRLF
 *
 * boundary = a bare UUID (okhttp uses UUID.randomUUID().toString()), advertised as
 * `multipart/form-data; boundary=<uuid>`.
 *
 * Header-case note: RN authors the part header key LOWERCASE
 * (node_modules/react-native/Libraries/Network/FormData.js:86 —
 * `const headers: Headers = {'content-disposition': contentDisposition};`) and
 * okhttp preserves the given case on the wire. That lowercase spelling is the
 * only one field-proven against this firmware — it is what the shipping app uses
 * to create /send-to-x4 — so it is the DEFAULT here: a byte-faithful port must
 * not silently differ from the app in the one byte-level detail it controls.
 * HTTP header names are case-insensitive, but if a hypothetical case-sensitive
 * parser ever wants the canonical spelling, --mkdir-canonical-header emits it.
 */
function buildMultipartBody(fields, { canonicalHeader = false } = {}) {
    const boundary = randomUUID();
    const dispositionKey = canonicalHeader ? 'Content-Disposition' : 'content-disposition';
    const parts = [];
    for (const [field, rawValue] of fields) {
        const value = Buffer.from(String(rawValue), 'utf8');
        parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `${dispositionKey}: form-data; name="${field}"\r\n` +
            `Content-Length: ${value.length}\r\n` +
            '\r\n',
            'utf8',
        ));
        parts.push(value);
        parts.push(Buffer.from('\r\n', 'utf8'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return {
        body: Buffer.concat(parts),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Step 1: ensure the target folder exists (crosspoint_upload.ts:240-297)
// ---------------------------------------------------------------------------

/**
 * Faithful port of ensureFolderExistsCrossPoint.
 *
 * Failure policy, matched to the app on purpose:
 *   - the app swallows a failed list check (crosspoint_upload.ts:265-268) and a
 *     failed mkdir (it returns false at :288/:291, but uploadToCrossPoint:187
 *     DISCARDS that boolean and calls uploadViaWebSocket regardless). So a bad
 *     HTTP status, a slow reply, or a parse error must NOT stop the upload here
 *     either — otherwise this tool fails on devices the app uploads to fine,
 *     which for an M1 "prove the pipe" run is a false negative on the hardware.
 *   - the ONE CLI-only addition is the DNS/connect fast path: if the very first
 *     request cannot resolve or cannot connect, the reader is genuinely not
 *     there, and saying so beats a mystery WS timeout 10s later. Timeouts are
 *     explicitly not in that set — see isUnreachable().
 *
 * `strictMkdir` opts back into hard-failing on an untolerated mkdir status, for
 * when you are debugging the firmware's mkdir handler rather than the pipe.
 */
async function ensureFolderExists({ host, httpPort = HTTP_PORT, devicePath, log, canonicalHeader = false, strictMkdir = false, listTimeoutMs = LIST_TIMEOUT_MS }) {
    const baseUrl = deviceBaseUrl(host, httpPort);
    const segments = folderSegments(devicePath);
    const steps = [];
    const warnings = [];

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        // crosspoint_upload.ts:246
        const parentDir = i === 0 ? '/' : '/' + segments.slice(0, i).join('/');

        // 1. Check if this level exists — crosspoint_upload.ts:249-268
        let exists = false;
        const listUrl = `${baseUrl}/api/files?path=${encodeURIComponent(parentDir)}`;
        try {
            const listRes = await fetchWithTimeout(listUrl, {}, listTimeoutMs);
            if (listRes.ok) {
                const items = await listRes.json();
                exists = Array.isArray(items) && items.some(
                    (item) => item && item.isDirectory && item.name === segment,
                );
            } else {
                log.debug(`list check for '${segment}': HTTP ${listRes.status}`);
            }
        } catch (e) {
            const info = classifyNetworkError(e, `GET ${listUrl}`);
            if (isUnreachable(info.kind)) {
                return { ok: false, unreachable: true, error: info.message, steps, warnings };
            }
            // Timeout / parse error / anything else: exactly what the app does —
            // note it and fall through to mkdir + upload.
            steps.push({ segment, parentDir, action: 'list-failed', kind: info.kind });
            warnings.push(`list check for '${segment}' failed (${info.message}); continuing to mkdir like the app does`);
            log.debug(`list check for '${segment}' failed: ${info.message}`);
        }

        if (exists) {                       // crosspoint_upload.ts:269
            steps.push({ segment, parentDir, action: 'exists' });
            log.debug(`'${segment}' already exists under '${parentDir}'`);
            continue;
        }

        // 2. Create this level — crosspoint_upload.ts:271-294
        try {
            const { body, contentType } = buildMultipartBody(
                [['name', segment], ['path', parentDir]],   // field order matches the app
                { canonicalHeader },
            );
            const createRes = await fetchWithTimeout(`${baseUrl}/mkdir`, {
                method: 'POST',
                headers: { 'Content-Type': contentType },
                body,
            }, MKDIR_TIMEOUT_MS);

            steps.push({ segment, parentDir, action: 'mkdir', status: createRes.status });
            log.debug(`POST /mkdir name='${segment}' path='${parentDir}' -> HTTP ${createRes.status}`);

            // crosspoint_upload.ts:287 — 400/409/500 are treated as "already there".
            if (!createRes.ok && createRes.status !== 400 && createRes.status !== 409 && createRes.status !== 500) {
                const detail = `mkdir failed for '${segment}': HTTP ${createRes.status}`;
                if (strictMkdir) {
                    return { ok: false, error: `${detail} (--strict-mkdir)`, steps, warnings };
                }
                // The app discards this failure and uploads anyway; so do we. If
                // the folder really is missing the firmware answers 'ERROR:' on
                // the WS upload, which is a truer signal than guessing here.
                warnings.push(`${detail}; continuing to the upload like the app does (pass --strict-mkdir to stop here)`);
            }
        } catch (e) {
            const info = classifyNetworkError(e, `POST ${baseUrl}/mkdir`);
            if (isUnreachable(info.kind)) {
                return { ok: false, unreachable: true, error: info.message, steps, warnings };
            }
            steps.push({ segment, parentDir, action: 'mkdir-failed', kind: info.kind });
            if (strictMkdir) {
                return { ok: false, error: `${info.message} (--strict-mkdir)`, steps, warnings };
            }
            warnings.push(`${info.message}; continuing to the upload like the app does (pass --strict-mkdir to stop here)`);
        }
    }

    return { ok: true, steps, warnings };
}

// ---------------------------------------------------------------------------
// Step 2: clear the target path (crosspoint_upload.ts:386-413)
// ---------------------------------------------------------------------------

/**
 * Faithful port of deleteCrossPointFile: `POST /delete` with an
 * application/x-www-form-urlencoded body of `path` + `type=file`.
 *
 * WHY THIS RUNS AT ALL — the firmware rejects an upload onto an existing path
 * ('ERROR: File already exists', proven on hardware 2026-07-28). The love-note
 * slot is a single fixed filename that is re-sent on every note, so a send with
 * no delete works exactly once per boot of the SD card and then silently keeps
 * showing the old note.
 *
 * WHY IT IS NEVER FATAL — a false/error result is the NORMAL first-send case:
 * there is no file (and no /.love-notes folder) to remove yet, and the app's
 * deleteCrossPointFile reports every non-OK status, including "no such file",
 * as a bare `false` that love_note_sender ignores. Hard-failing here would make
 * the first note the one that cannot be sent. And if the file genuinely is
 * still there, the upload's own 'File already exists' is a truer report than
 * anything this step could guess — so even a connect failure only warns and
 * lets the reachability verdict come from the mkdir preflight, keeping one
 * unreachability story instead of two.
 */
async function deleteRemoteFile({ host, httpPort = HTTP_PORT, devicePath, name, log, timeoutMs = DELETE_TIMEOUT_MS }) {
    const baseUrl = deviceBaseUrl(host, httpPort);
    const path = deviceFilePath(devicePath, name);

    const params = new URLSearchParams();
    params.append('path', path);            // field order matches the app
    params.append('type', 'file');

    try {
        const res = await fetchWithTimeout(`${baseUrl}/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        }, timeoutMs);

        log.debug(`POST /delete path='${path}' type=file -> HTTP ${res.status}`);
        // res.ok is exactly the app's return value (crosspoint_upload.ts:412).
        return { attempted: true, removed: res.ok, status: res.status, path };
    } catch (e) {
        const info = classifyNetworkError(e, `POST ${baseUrl}/delete`);
        log.debug(`delete of '${path}' failed: ${info.message}`);
        return { attempted: true, removed: false, kind: info.kind, error: info.message, path };
    }
}

// ---------------------------------------------------------------------------
// Step 3: WebSocket upload (crosspoint_upload.ts:53-173)
// ---------------------------------------------------------------------------

/**
 * Wire protocol, unchanged from the app:
 *   1. connect ws://<host>:81/
 *   2. send text "START:<filename>:<size>:<path>"
 *   3. wait for text "READY"
 *   4. send binary chunks of <=4096 B, at most 128KB unacked
 *      (server acks with "PROGRESS:<current>:<total>")
 *   5. wait for "DONE" or "ERROR:<reason>"
 */
function uploadViaWebSocket({ host, wsPort = WS_PORT, filename, data, targetPath, onProgress, log, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS }) {
    return new Promise((resolve) => {
        const wsUrl = `ws://${host}:${wsPort}/`;
        log.debug(`[WS] connecting to ${wsUrl}`);

        let settled = false;
        let ws;
        let uploadTimer = null;
        let handshakeTimer = null;
        // 'connect' -> socket not open yet | 'handshake' -> open, awaiting READY | 'transfer'
        let phase = 'connect';

        const finish = (result) => {
            if (settled) return;            // crosspoint_upload.ts relies on Promise-resolve-once; same effect
            settled = true;
            if (uploadTimer) clearTimeout(uploadTimer);
            if (handshakeTimer) clearTimeout(handshakeTimer);
            try {
                if (ws && ws.readyState === WebSocket.OPEN) ws.close();
                else if (ws) ws.terminate();
            } catch { /* ignore */ }
            resolve({ phase, ...result });
        };

        try {
            ws = new WebSocket(wsUrl, { handshakeTimeout: handshakeTimeoutMs });
        } catch (e) {
            const info = classifyNetworkError(e, `connect ${wsUrl}`);
            resolve({ success: false, error: info.message, kind: info.kind, phase: 'connect' });
            return;
        }

        let serverAcked = 0;                        // crosspoint_upload.ts:65
        let ackResolver = null;                     // crosspoint_upload.ts:66
        let sentBytes = 0;
        let chunkCount = 0;
        let ready = false;

        // crosspoint_upload.ts:70-73 — overall safety timeout
        uploadTimer = setTimeout(() => {
            finish({ success: false, error: 'WebSocket upload timed out', kind: 'timeout' });
        }, UPLOAD_TIMEOUT_MS);

        ws.on('open', () => {
            // crosspoint_upload.ts:75-78
            phase = 'handshake';
            const start = `START:${filename}:${data.length}:${targetPath}`;
            log.debug(`[WS] connected, sending: ${start}`);
            ws.send(start);

            handshakeTimer = setTimeout(() => {
                if (!ready) {
                    finish({
                        success: false,
                        kind: 'timeout',
                        error: `no READY from device within ${handshakeTimeoutMs}ms of START`,
                    });
                }
            }, handshakeTimeoutMs);
        });

        ws.on('message', (raw) => {
            // The firmware only ever sends text frames; ws@7 hands those over as a
            // string, ws@8 as a Buffer. Normalize so the app's string compares hold.
            const msg = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');

            if (msg === 'READY') {                  // crosspoint_upload.ts:84
                if (ready) return;
                ready = true;
                phase = 'transfer';
                if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
                log.debug('[WS] server READY, streaming chunks');

                let offset = 0;
                const sendChunks = async () => {
                    try {
                        // crosspoint_upload.ts:92-116, copied including the offset quirk.
                        while (offset < data.length && ws.readyState === WebSocket.OPEN) {
                            if (offset - serverAcked >= MAX_IN_FLIGHT) {
                                await new Promise((release) => {
                                    ackResolver = release;
                                    // crosspoint_upload.ts:97-103 — fallback if a PROGRESS is missed
                                    setTimeout(() => {
                                        if (ackResolver === release) {
                                            ackResolver = null;
                                            release();
                                        }
                                    }, ACK_FALLBACK_MS);
                                });
                            }

                            const end = Math.min(offset + CHUNK_SIZE, data.length);
                            const chunk = data.slice(offset, end);   // Uint8Array#slice copies
                            ws.send(chunk);
                            sentBytes += chunk.length;
                            chunkCount += 1;
                            // QUIRK (crosspoint_upload.ts:110): offset advances by a full
                            // CHUNK_SIZE even when the final chunk is short, so after the
                            // last send offset can exceed data.length. Kept as-is: it only
                            // affects the loop exit and the modulo yield below.
                            offset += CHUNK_SIZE;

                            if (onProgress) onProgress({ sentBytes, total: data.length, chunkCount });

                            // crosspoint_upload.ts:112-115 — 10ms yield every 16KB
                            if (offset % YIELD_EVERY_BYTES === 0) {
                                await new Promise((r) => setTimeout(r, YIELD_MS));
                            }
                        }
                        log.debug(`[WS] all ${chunkCount} chunks sent (${sentBytes} B), waiting for DONE`);
                    } catch (err) {
                        // crosspoint_upload.ts:118-123
                        finish({ success: false, error: `error sending binary data: ${err?.message ?? err}` });
                    }
                };
                void sendChunks();
            } else if (msg === 'DONE') {            // crosspoint_upload.ts:127
                log.debug('[WS] DONE');
                finish({ success: true, sentBytes, chunkCount });
            } else if (msg.startsWith('ERROR:')) {  // crosspoint_upload.ts:132
                finish({
                    success: false,
                    kind: 'device',
                    error: msg.replace('ERROR:', '').trim(),   // same stripping as the app
                });
            } else if (msg.startsWith('PROGRESS:')) {   // crosspoint_upload.ts:137-154
                const parts = msg.split(':');
                if (parts.length === 3) {
                    const current = parseInt(parts[1], 10);
                    const total = parseInt(parts[2], 10);
                    serverAcked = current;

                    if (ackResolver) {
                        ackResolver();
                        ackResolver = null;
                    }

                    if (total > 0 && onProgress) {
                        const percent = Math.min(100, Math.round((current / total) * 100));
                        onProgress({ sentBytes, total: data.length, chunkCount, ackedPercent: percent });
                    }
                }
            } else {
                log.debug(`[WS] unexpected message: ${msg}`);
            }
        });

        ws.on('error', (e) => {                     // crosspoint_upload.ts:158-163
            const info = classifyNetworkError(e, `ws ${wsUrl}`);
            finish({ success: false, error: info.message, kind: info.kind });
        });

        ws.on('close', (code, reason) => {          // crosspoint_upload.ts:165-171
            log.debug(`[WS] closed: ${code} ${reason ?? ''}`);
            finish({ success: false, error: 'connection closed unexpectedly (no DONE from device)' });
        });
    });
}

// ---------------------------------------------------------------------------
// Step 4: --verify (listCrossPointSleepFiles-style listing, crosspoint_upload.ts:465-505)
// ---------------------------------------------------------------------------

async function verifyRemoteFile({ host, httpPort = HTTP_PORT, devicePath, name, expectedSize }) {
    const baseUrl = deviceBaseUrl(host, httpPort);
    const target = deviceTargetPath(devicePath);
    // crosspoint_upload.ts:472 encodes the path exactly like this.
    const url = `${baseUrl}/api/files?path=${encodeURIComponent(target)}`;
    try {
        const res = await fetchWithTimeout(url, {}, VERIFY_TIMEOUT_MS);
        if (!res.ok) return { ok: false, error: `GET /api/files -> HTTP ${res.status}` };
        const items = await res.json();
        if (!Array.isArray(items)) return { ok: false, error: '/api/files did not return an array' };

        const match = items.find((item) => {
            if (!item || typeof item.name !== 'string') return false;
            if (item.isDirectory === true || item.type === 'dir') return false;
            return item.name === name || safeDecodeURIComponent(item.name) === name;
        });

        if (!match) {
            const names = items.map((i) => i?.name).filter(Boolean);
            return { ok: false, error: `'${name}' not listed in ${target} (saw: ${names.join(', ') || 'nothing'})` };
        }
        const size = Number(match.size);
        if (!Number.isFinite(size)) return { ok: false, error: `'${name}' listed without a usable size field`, entry: match };
        if (size !== expectedSize) {
            return { ok: false, error: `'${name}' is ${size} B on device, expected ${expectedSize} B`, entry: match, size };
        }
        return { ok: true, size, entry: match };
    } catch (e) {
        const info = classifyNetworkError(e, `GET ${url}`);
        return { ok: false, error: info.message, kind: info.kind };
    }
}

// ---------------------------------------------------------------------------
// Orchestration (used by both the CLI and --self-test)
// ---------------------------------------------------------------------------

async function sendFrame({ host, wsPort = WS_PORT, httpPort = HTTP_PORT, devicePath, name, data, log, verify = false, canonicalHeader = false, strictMkdir = false, deleteFirst = true, stageId = true, noteId = null, settleMs = VERIFY_SETTLE_MS, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS, listTimeoutMs = LIST_TIMEOUT_MS, deleteTimeoutMs = DELETE_TIMEOUT_MS }) {
    const targetPath = deviceTargetPath(devicePath);

    // The sidecar is only meaningful next to the firmware's OWN frame name. Under
    // any other --name the frame is not what MessageSync reads, so a current.id
    // beside it would name a note that is not there — and the reader would then
    // mark that id shown while displaying whatever current.frame still holds,
    // suppressing the real note when it later arrives. So: no id, no delete of
    // one, and a warning rather than a silent skip.
    // Belt and braces: runCli already rejects a bad --id, but an in-process caller
    // (the self-test, a future script) must not be able to get as far as writing
    // the frame and only then discover the id is unusable.
    if (noteId !== null && noteId !== undefined) {
        const idProblem = describeNoteIdProblem(noteId);
        if (idProblem !== null) {
            return { ok: false, stage: 'upload-id', unreachable: false, error: idProblem, idStaged: false };
        }
    }

    const idApplies = name === DEFAULT_NAME;
    if (!idApplies && (stageId || noteId)) {
        log.warn(`--name is '${name}', not '${DEFAULT_NAME}': skipping the ${DEFAULT_ID_NAME} sidecar entirely (an id beside a differently-named frame describes a note the firmware cannot find)`);
    }
    const writeId = idApplies && stageId;

    log.info(`-> ${host}  ${targetPath}/${name}  (${data.length} B, ${Math.ceil(data.length / CHUNK_SIZE)} chunks)`);

    // ORDER IS LOAD-BEARING: delete id, delete frame, mkdir, upload frame, upload
    // id — the same order love_note_sender.ts uses (two deletes, then
    // uploadToCrossPoint, which mkdirs internally, then the sidecar).
    //
    //   * The firmware will not overwrite an existing path, so moving a delete
    //     after its upload, or dropping it, turns every re-send into
    //     'ERROR: File already exists' with the OLD note still on the panel.
    //   * The id is cleared FIRST and unconditionally (even under --no-id), so
    //     from here until the sidecar is written no id on the card can describe
    //     anything but the frame actually stored. A leftover id next to a new
    //     frame is not a cosmetic problem: it still equals messageLastShownId, so
    //     hasUnreadNote answers false and the new note is never shown at all.
    //   * The id is uploaded LAST, and only after the frame's DONE — see the file
    //     header for why an id ahead of its frame is worse than no id.
    let removedId = null;
    let removed = null;
    if (deleteFirst) {
        if (idApplies) {
            removedId = await deleteRemoteFile({ host, httpPort, devicePath, name: DEFAULT_ID_NAME, log, timeoutMs: deleteTimeoutMs });
            if (removedId.error) {
                log.warn(`pre-upload delete of ${removedId.path} failed (${removedId.error}); continuing`);
            } else {
                log.debug(removedId.removed ? `cleared ${removedId.path} before upload` : `nothing to delete at ${removedId.path} (HTTP ${removedId.status}) — normal on a first send`);
            }
        }
        removed = await deleteRemoteFile({ host, httpPort, devicePath, name, log, timeoutMs: deleteTimeoutMs });
        if (removed.error) {
            log.warn(`pre-upload delete of ${removed.path} failed (${removed.error}); continuing — the upload will report 'File already exists' if the file is really still there`);
        } else if (!removed.removed) {
            log.debug(`nothing to delete at ${removed.path} (HTTP ${removed.status}) — normal on a first send`);
        } else {
            log.debug(`cleared ${removed.path} before upload`);
        }
    } else {
        log.warn('--no-delete: uploading without clearing the target first; the firmware rejects an upload onto an existing path');
    }

    const folder = await ensureFolderExists({ host, httpPort, devicePath, log, canonicalHeader, strictMkdir, listTimeoutMs });
    // Non-fatal folder-setup problems are reported but never block the upload —
    // the app ignores them entirely (see ensureFolderExists' header).
    for (const w of folder.warnings ?? []) log.warn(w);
    if (!folder.ok) {
        return { ok: false, stage: 'mkdir', unreachable: folder.unreachable === true, error: folder.error, folder, removed, removedId };
    }

    const result = await uploadViaWebSocket({
        host,
        wsPort,
        filename: name,
        data,
        targetPath,
        log,
        handshakeTimeoutMs,
        onProgress: (p) => log.progress(p),
    });
    log.progressDone();

    if (!result.success) {
        return {
            ok: false,
            stage: 'upload',
            // Failing before the socket ever opened means the reader is not there /
            // not listening on :81 — same operator hint as a DNS/connect failure.
            // A timeout *after* the socket opened is a protocol stall, not unreachability.
            unreachable: result.phase === 'connect' || result.kind === 'dns' || result.kind === 'connect',
            kind: result.kind,
            phase: result.phase,
            error: result.error,
            folder,
            removed,
            removedId,
            // Nothing was staged: an id pointing at a frame that failed to land is
            // worse than no id (the header spells out why).
            idStaged: false,
        };
    }

    log.info(`Uploaded ${result.sentBytes} B in ${result.chunkCount} chunks; device acked DONE.`);

    // The frame is on the card and acked. ONLY NOW the sidecar.
    let idUpload = null;
    let stagedId = null;
    if (writeId) {
        stagedId = noteId ?? mintNoteId();
        const idBytes = new Uint8Array(Buffer.from(stagedId, 'ascii'));
        idUpload = await uploadViaWebSocket({
            host,
            wsPort,
            filename: DEFAULT_ID_NAME,
            data: idBytes,
            targetPath,
            log,
            handshakeTimeoutMs,
            // No progress line for 21 bytes: the bar already reached 100% on the
            // frame, and a second ramp reads as a stall and restart.
            onProgress: () => {},
        });
        if (!idUpload.success) {
            // Reported as a FAILURE even though the frame landed, unlike the app
            // (love_note_sender treats this as a degraded success so a delivered
            // note is not re-sent through the mailbox). This is a diagnostic tool
            // whose exit code is read by scripts: an upload of a file the firmware
            // reads did fail, and the operator's remedy is to re-run. The log above
            // already says the frame landed.
            log.warn(`the FRAME landed but its ${DEFAULT_ID_NAME} sidecar did not: the reader will re-show this note on every wake until an id is staged. Re-run to fix.`);
            return {
                ok: false,
                stage: 'upload-id',
                unreachable: idUpload.phase === 'connect' || idUpload.kind === 'dns' || idUpload.kind === 'connect',
                kind: idUpload.kind,
                phase: idUpload.phase,
                error: idUpload.error,
                upload: result,
                idUpload,
                noteId: stagedId,
                idStaged: false,
                folder,
                removed,
                removedId,
            };
        }
        log.info(`Staged note id '${stagedId}' in ${targetPath}/${DEFAULT_ID_NAME} (${idBytes.length} B).`);
    } else if (idApplies) {
        log.warn(`--no-id: no ${DEFAULT_ID_NAME} written, so the reader treats this as a legacy id-less note and re-shows it on EVERY wake`);
    }

    const done = { ok: true, upload: result, idUpload, noteId: stagedId, idStaged: Boolean(stagedId), folder, removed, removedId };
    if (!verify) return done;

    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    const check = await verifyRemoteFile({ host, httpPort, devicePath, name, expectedSize: data.length });
    if (!check.ok) {
        return { ...done, ok: false, stage: 'verify', error: check.error, verify: check };
    }
    log.info(`Verified: ${targetPath}/${name} listed at ${check.size} B.`);

    // Verify BOTH halves of the write, or --verify would pass while the reader is
    // still missing the file that decides whether the note is ever dismissed.
    if (!stagedId) return { ...done, verify: check };
    const idCheck = await verifyRemoteFile({ host, httpPort, devicePath, name: DEFAULT_ID_NAME, expectedSize: stagedId.length });
    if (!idCheck.ok) {
        return { ...done, ok: false, stage: 'verify-id', error: idCheck.error, verify: check, verifyId: idCheck };
    }
    log.info(`Verified: ${targetPath}/${DEFAULT_ID_NAME} listed at ${idCheck.size} B.`);
    return { ...done, verify: check, verifyId: idCheck };
}

// ---------------------------------------------------------------------------
// Logging / progress
// ---------------------------------------------------------------------------

function makeLogger({ quiet = false, debug = false } = {}) {
    let lastRender = 0;
    let dirty = false;
    let lastLine = null;
    const tty = Boolean(process.stdout.isTTY);
    return {
        info: (msg) => { if (!quiet) process.stdout.write(`${msg}\n`); },
        warn: (msg) => process.stderr.write(`warn: ${msg}\n`),
        error: (msg) => process.stderr.write(`error: ${msg}\n`),
        debug: (msg) => { if (debug) process.stderr.write(`  [dbg] ${msg}\n`); },
        progress: ({ sentBytes, total, ackedPercent }) => {
            if (quiet) return;
            const now = Date.now();
            const complete = sentBytes >= total;
            if (!complete && now - lastRender < 120) return;
            lastRender = now;
            dirty = true;
            const pct = total > 0 ? Math.round((sentBytes / total) * 100) : 0;
            const acked = ackedPercent === undefined ? '' : `  device ${ackedPercent}%`;
            const line = `  sending ${sentBytes}/${total} B (${pct}%)${acked}`;
            if (line === lastLine) return;
            lastLine = line;
            if (tty) process.stdout.write(`\r${line.padEnd(60)}`);
            else process.stdout.write(`${line}\n`);
        },
        progressDone: () => {
            if (!quiet && tty && dirty) process.stdout.write('\n');
            dirty = false;
        },
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `send_frame.mjs — upload a love-note frame to an Xteink X3 (CrossPoint firmware)

  node scripts/send_frame.mjs <file> [options]
  node scripts/send_frame.mjs --self-test

Options:
  --host <host>   device host or IP            (default: ${DEFAULT_HOST})
  --path <path>   device folder                (default: ${DEFAULT_DEVICE_PATH})
  --name <name>   remote filename              (default: ${DEFAULT_NAME})
  --verify        re-list the folder after DONE and check name + size
  --dry-run       print the resolved plan and exit, no network
  --force         allow a file that is not exactly ${FRAME_BYTES} bytes
  --no-delete     skip the POST /delete that clears the target path first.
                  The firmware REFUSES to overwrite an existing file, so this
                  makes every send after the first one fail — it exists only to
                  observe that rejection deliberately.
  --id <id>       note id to stage in ${DEFAULT_ID_NAME} after the frame
                  (default: mint one, same scheme as the app). [A-Za-z0-9._~-],
                  ${NOTE_ID_MAX_CHARS} chars max — the reader silently truncates past that.
  --no-id         do not write ${DEFAULT_ID_NAME}. The reader then treats the note as
                  legacy/id-less and RE-SHOWS IT ON EVERY WAKE; use it only to
                  observe that behaviour. The old id is still deleted, because a
                  stale one suppresses the new note entirely instead.
                  Both are ignored unless --name is '${DEFAULT_NAME}'.
  --self-test     run the offline protocol test against an in-process mock device
  --debug         verbose protocol logging on stderr
  --quiet         suppress progress/info output
  --mkdir-canonical-header
                  send the canonical 'Content-Disposition' in the /mkdir
                  multipart body instead of the RN/okhttp-exact lowercase
                  'content-disposition' this tool sends by default
  --strict-mkdir  stop on an untolerated /mkdir status instead of warning and
                  uploading anyway (the app always uploads anyway)
  -h, --help      this text

Test hooks (leave unset for real hardware):
  SEND_FRAME_HTTP_PORT / SEND_FRAME_WS_PORT   override the fixed :80 / :81 ports so
  the CLI can be driven against a mock device on an unprivileged port.

Exit codes: 0 ok | 1 upload/protocol failure | 2 usage/validation | 3 device unreachable`;

const VALUE_FLAGS = new Map([['--host', 'host'], ['--path', 'devicePath'], ['--name', 'name'], ['--id', 'noteId']]);
const BOOL_FLAGS = new Map([
    ['--verify', 'verify'], ['--dry-run', 'dryRun'], ['--force', 'force'],
    ['--self-test', 'selfTest'], ['--debug', 'debug'], ['--quiet', 'quiet'],
    ['--mkdir-canonical-header', 'canonicalHeader'], ['--strict-mkdir', 'strictMkdir'],
    ['--no-delete', 'noDelete'], ['--no-id', 'noId'],
    ['--help', 'help'], ['-h', 'help'],
]);

function parseArgs(argv) {
    const opts = {
        host: DEFAULT_HOST,
        devicePath: DEFAULT_DEVICE_PATH,
        name: DEFAULT_NAME,
        verify: false, dryRun: false, force: false, selfTest: false,
        debug: false, quiet: false, canonicalHeader: false, strictMkdir: false,
        // Delete-before-upload is the DEFAULT; --no-delete only turns it off.
        noDelete: false,
        // Staging current.id is the DEFAULT; --no-id only turns it off, and
        // --id pins the value instead of minting one.
        noId: false,
        noteId: null,
        help: false,
        file: null,
    };

    // Expand --key=value into two tokens.
    const tokens = [];
    for (const arg of argv) {
        if (arg.startsWith('--') && arg.includes('=')) {
            const eq = arg.indexOf('=');
            tokens.push(arg.slice(0, eq), arg.slice(eq + 1));
        } else {
            tokens.push(arg);
        }
    }

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (BOOL_FLAGS.has(token)) {
            opts[BOOL_FLAGS.get(token)] = true;
        } else if (VALUE_FLAGS.has(token)) {
            const value = tokens[++i];
            if (value === undefined) throw new UsageError(`${token} requires a value`);
            opts[VALUE_FLAGS.get(token)] = value;
        } else if (token.startsWith('-')) {
            throw new UsageError(`unknown option '${token}'`);
        } else if (opts.file === null) {
            opts.file = token;
        } else {
            throw new UsageError(`unexpected extra argument '${token}'`);
        }
    }
    return opts;
}

/** One line describing what will happen to `current.id`, for --dry-run. */
function idSidecarPlan(opts) {
    if (opts.name !== DEFAULT_NAME) {
        return `skipped — --name is '${opts.name}', not '${DEFAULT_NAME}' (an id beside a differently-named frame names a note the firmware cannot find)`;
    }
    const slot = deviceFilePath(opts.devicePath, DEFAULT_ID_NAME);
    if (opts.noId) {
        return `OFF (--no-id) — ${slot} is still DELETED, then left absent: the reader re-shows this note on every wake`;
    }
    return (
        `${slot} <- ${opts.noteId === null ? 'a freshly minted id' : `'${opts.noteId}'`}` +
        `${opts.noDelete ? '' : ' (this slot is DELETED first, before the frame\'s)'}, uploaded AFTER the frame's DONE`
    );
}

async function runCli(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        if (e instanceof UsageError) {
            process.stderr.write(`error: ${e.message}\n\n${HELP}\n`);
            return EXIT_USAGE;
        }
        throw e;
    }

    if (opts.help) {
        process.stdout.write(`${HELP}\n`);
        return EXIT_OK;
    }

    if (opts.selfTest) return runSelfTest({ debug: opts.debug });

    const log = makeLogger({ quiet: opts.quiet, debug: opts.debug });

    if (!opts.file) {
        process.stderr.write(`error: no input file\n\n${HELP}\n`);
        return EXIT_USAGE;
    }

    const host = normalizeDeviceHost(opts.host);
    if (!host) {
        process.stderr.write('error: --host is empty\n');
        return EXIT_USAGE;
    }
    if (host.includes(':')) {
        process.stderr.write(`error: --host must be a bare host or IP ('${host}' has a port); ports are fixed: HTTP ${HTTP_PORT}, WS ${WS_PORT}\n`);
        return EXIT_USAGE;
    }
    if (!opts.name || opts.name.includes('/')) {
        process.stderr.write(`error: --name must be a bare filename (got '${opts.name}')\n`);
        return EXIT_USAGE;
    }
    if (opts.noId && opts.noteId !== null) {
        // Silently honouring one of them would make the card's state depend on
        // flag order, and this tool exists to make that state predictable.
        process.stderr.write('error: --id and --no-id contradict each other; pass at most one\n');
        return EXIT_USAGE;
    }
    if (opts.noteId !== null) {
        const idProblem = describeNoteIdProblem(opts.noteId);
        if (idProblem !== null) {
            // Rejected BEFORE the frame is written: discovering it afterwards
            // would leave the reader holding an id-less frame.
            process.stderr.write(`error: --id: ${idProblem}\n`);
            return EXIT_USAGE;
        }
    }

    const filePath = resolvePath(process.cwd(), opts.file);
    let buf;
    try {
        buf = await readFile(filePath);
    } catch (e) {
        process.stderr.write(`error: cannot read ${filePath}: ${e?.message ?? e}\n`);
        return EXIT_USAGE;
    }

    if (buf.length !== FRAME_BYTES && !opts.force) {
        process.stderr.write(
            `error: ${filePath} is ${buf.length} bytes; a love-note frame must be exactly ${FRAME_BYTES} ` +
            '(528 rows x 99 bytes, 1 bit/px, 792 px wide).\n' +
            '       The firmware raw-blits this file with no header and no length negotiation, so a\n' +
            '       wrong size renders garbage. Pass --force to upload it anyway.\n',
        );
        return EXIT_USAGE;
    }
    if (buf.length !== FRAME_BYTES) {
        log.warn(`--force: uploading ${buf.length} bytes (expected ${FRAME_BYTES}); the device will render garbage unless this is a non-frame file.`);
    }

    // Zero-copy view; Uint8Array#slice (used by the chunker) still copies.
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const targetPath = deviceTargetPath(opts.devicePath);
    const chunks = Math.ceil(data.length / CHUNK_SIZE);

    // Test-only: :80/:81 are privileged, so a mock device cannot claim them.
    const httpPort = Number(process.env.SEND_FRAME_HTTP_PORT) || HTTP_PORT;
    const wsPort = Number(process.env.SEND_FRAME_WS_PORT) || WS_PORT;
    if (httpPort !== HTTP_PORT || wsPort !== WS_PORT) {
        log.warn(`port override in effect: HTTP ${httpPort}, WS ${wsPort} (SEND_FRAME_*_PORT)`);
    }

    if (opts.dryRun) {
        process.stdout.write([
            'dry run — no network traffic',
            `  source file : ${filePath}`,
            `  size        : ${data.length} B${data.length === FRAME_BYTES ? ' (exact love-note frame)' : ' (NOT a standard frame size)'}`,
            `  host        : ${host}`,
            `  http base   : ${deviceBaseUrl(host, httpPort)}`,
            `  ws url      : ws://${host}:${wsPort}/`,
            `  delete first: ${opts.noDelete ? 'OFF (--no-delete) — the firmware will reject an upload onto an existing file' : `POST ${deviceBaseUrl(host, httpPort)}/delete  path=${deviceFilePath(opts.devicePath, opts.name)}  type=file`}`,
            `  id sidecar  : ${idSidecarPlan(opts)}`,
            `  mkdir steps : ${folderSegments(opts.devicePath).map((s, i, a) => `name='${s}' path='${i === 0 ? '/' : '/' + a.slice(0, i).join('/')}'`).join(' then ') || '(none — root)'}`,
            `  device path : ${targetPath}`,
            `  remote name : ${opts.name}`,
            `  START line  : START:${opts.name}:${data.length}:${targetPath}`,
            `  chunking    : ${chunks} chunks of ${CHUNK_SIZE} B (last ${data.length - (chunks - 1) * CHUNK_SIZE} B), ${MAX_IN_FLIGHT} B in-flight window`,
            `  verify      : ${opts.verify ? `GET ${deviceBaseUrl(host, httpPort)}/api/files?path=${encodeURIComponent(targetPath)}` : 'off'}`,
            '',
        ].join('\n'));
        return EXIT_OK;
    }

    const result = await sendFrame({
        host, httpPort, wsPort, devicePath: opts.devicePath, name: opts.name, data, log,
        verify: opts.verify, canonicalHeader: opts.canonicalHeader, strictMkdir: opts.strictMkdir,
        deleteFirst: !opts.noDelete,
        stageId: !opts.noId, noteId: opts.noteId,
    });

    if (result.ok) {
        log.info(result.idStaged ? `OK (note id ${result.noteId})` : 'OK');
        return EXIT_OK;
    }

    log.error(`${STAGE_LABEL[result.stage] ?? result.stage} failed: ${result.error}`);
    if (result.unreachable) {
        process.stderr.write(`\nCannot reach the reader at '${host}'.\n${reachHint(host)}\n`);
        return EXIT_UNREACHABLE;
    }
    if (result.kind === 'device') {
        process.stderr.write('\nThe device rejected the upload (the text above is the firmware\'s own ERROR: reason).\n');
        if (/exist/i.test(result.error ?? '')) {
            // Name the file the firmware actually refused: the frame, or the id
            // sidecar that is uploaded after it.
            const refused = deviceFilePath(opts.devicePath, result.stage === 'upload-id' ? DEFAULT_ID_NAME : opts.name);
            process.stderr.write(
                opts.noDelete
                    ? 'That is exactly what --no-delete asks for: the firmware will not overwrite a file. Drop --no-delete.\n'
                    : `The pre-upload delete did not clear ${refused} — re-run with --debug to see the /delete status.\n`,
            );
        }
    } else if (result.phase === 'handshake') {
        process.stderr.write(
            `\nThe device accepted a WebSocket connection on :${wsPort} but never answered START.\n` +
            'That usually means the firmware is not the CrossPoint upload server, or it is busy/wedged — power-cycle the reader and retry.\n',
        );
    }
    return EXIT_FAIL;
}

// ---------------------------------------------------------------------------
// --self-test: in-process mock CrossPoint device, real client code path
// ---------------------------------------------------------------------------

/**
 * Mock device: HTTP (/api/files, /mkdir, /delete) + WS :N implementing
 * START -> READY -> binary chunks -> PROGRESS -> DONE, per the protocol read out
 * of crosspoint_upload.ts. Records everything the client sends.
 *
 * IT KEEPS A FILESYSTEM, AND IT REFUSES TO OVERWRITE. `existingFiles` seeds a
 * set of absolute paths; `POST /delete` removes from it (404 when the path is
 * not there, which is what the real firmware reports for a missing file); a
 * START naming a path already in the set answers `ERROR:File already exists`
 * and streams nothing — the behaviour proven on the physical X3 on 2026-07-28.
 *
 * That last rule is what makes delete-before-upload TESTABLE rather than
 * merely asserted: a client that skips the delete, or issues it after the
 * upload, fails here for the same reason it fails on hardware. `record.order`
 * additionally captures the interleaving so the ordering itself is checkable,
 * not just its outcome.
 *
 * A send now writes TWO files (frame + `current.id`), so uploads are recorded
 * BOTH cumulatively (`record.startLine`/`chunkSizes`/`received`/`receivedBytes`,
 * unchanged) and PER FILE in `record.uploads[]` — `{ startLine, path, name,
 * chunkSizes, bytes, data }`. Anything that means "the frame" must read the
 * per-file entry, or a 21-byte sidecar silently shifts the frame's own numbers.
 * `record.contents` keeps each stored file's bytes, because for the sidecar the
 * bytes ARE the contract.
 */
async function startMockDevice({ listing = [], wsBehavior = 'ok', progressMode = 'each', errorText = 'mock failure', listDelayMs = 0, mkdirStatus = 200, existingFiles = [], enforceExistsRejection = true } = {}) {
    const record = {
        httpRequests: [],
        startLine: null,
        chunkSizes: [],
        received: [],
        receivedBytes: 0,
        progressSent: 0,
        /** Ordered protocol events: 'delete:<path>' / 'start:<path>' / 'stored:<path>'. */
        order: [],
        deletes: [],
        /** One entry per upload, in order — see this function's header. */
        uploads: [],
        /** path -> Buffer of what was actually stored there. */
        contents: new Map(),
    };
    /** The mock device's SD card: absolute paths that currently exist. */
    const files = new Set(existingFiles);
    let releaseProgress = progressMode !== 'withhold';

    const httpServer = createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const url = new URL(req.url, 'http://mock');
            record.httpRequests.push({
                method: req.method,
                path: url.pathname,
                query: url.searchParams.get('path'),
                contentType: req.headers['content-type'] ?? null,
                body,
            });
            if (req.method === 'GET' && url.pathname === '/api/files') {
                const path = url.searchParams.get('path');
                const items = typeof listing === 'function' ? listing(path) : listing;
                const reply = () => {
                    if (res.destroyed || res.writableEnded) return;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(items));
                };
                // listDelayMs simulates a busy ESP32-C3 doing an SD dir listing
                // while refreshing the panel — slow, but very much alive.
                if (listDelayMs > 0) setTimeout(reply, listDelayMs).unref();
                else reply();
                return;
            }
            if (req.method === 'POST' && url.pathname === '/mkdir') {
                res.writeHead(mkdirStatus, { 'Content-Type': 'text/plain' });
                res.end(mkdirStatus === 200 ? 'OK' : 'nope');
                return;
            }
            if (req.method === 'POST' && url.pathname === '/delete') {
                // crosspoint_upload.ts:395-406 posts application/x-www-form-urlencoded
                // with fields `path` and `type`.
                const form = new URLSearchParams(body.toString('utf8'));
                const target = form.get('path') ?? '';
                const existed = files.delete(target);
                record.deletes.push({ path: target, type: form.get('type'), existed });
                record.order.push(`delete:${target}`);
                // A delete of nothing is a 404, exactly the case a first-ever send
                // hits — the client has to treat it as normal, not as a failure.
                res.writeHead(existed ? 200 : 404, { 'Content-Type': 'text/plain' });
                res.end(existed ? 'OK' : 'not found');
                return;
            }
            res.writeHead(404);
            res.end('not found');
        });
    });
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));

    const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.on('listening', r));

    wss.on('connection', (socket) => {
        let total = 0;
        let storePath = null;
        /** The record.uploads entry for THIS connection's file. */
        let entry = null;
        // PER-CONNECTION byte count. record.receivedBytes stays CUMULATIVE across
        // uploads (the existing assertions read it), but the DONE decision must
        // not: a second upload on the same mock would otherwise complete on its
        // very first chunk, because the first upload's bytes already cover total.
        let connBytes = 0;
        socket.on('message', (raw, maybeBinary) => {
            const isBinary = typeof raw !== 'string' && maybeBinary !== false;
            if (!isBinary) {
                const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
                if (text.startsWith('START:')) {
                    record.startLine = text;
                    // START:<filename>:<size>:<dir>. Split on ':' from the ends so a
                    // ':' inside a name cannot shift the size field.
                    const parts = text.slice('START:'.length).split(':');
                    const dir = parts.pop();
                    total = parseInt(parts.pop(), 10);
                    const filename = parts.join(':');
                    storePath = dir === '/' ? `/${filename}` : `${dir}/${filename}`;
                    record.order.push(`start:${storePath}`);
                    entry = { startLine: text, path: storePath, name: filename, declaredSize: total, chunkSizes: [], received: [], bytes: 0 };
                    record.uploads.push(entry);

                    if (wsBehavior === 'error-on-start') {
                        socket.send(`ERROR:${errorText}`);
                        return;
                    }
                    // THE FIRMWARE'S OVERWRITE REFUSAL, proven on hardware
                    // 2026-07-28. Checked BEFORE READY, so a client that skipped
                    // the delete never gets to stream a byte.
                    if (enforceExistsRejection && files.has(storePath)) {
                        socket.send('ERROR:File already exists');
                        return;
                    }
                    if (wsBehavior === 'silent') return;   // never sends READY
                    socket.send('READY');
                }
                return;
            }
            const buf = Buffer.from(raw);
            record.chunkSizes.push(buf.length);
            record.received.push(buf);
            record.receivedBytes += buf.length;
            connBytes += buf.length;
            if (entry) {
                entry.chunkSizes.push(buf.length);
                entry.received.push(buf);
                entry.bytes += buf.length;
            }

            if (wsBehavior === 'error-mid') {
                socket.send(`ERROR:${errorText}`);
                return;
            }
            if (releaseProgress) {
                record.progressSent += 1;
                socket.send(`PROGRESS:${connBytes}:${total}`);
            }
            if (connBytes >= total) {
                // The write lands only now, so a re-send really does hit an
                // existing path the way a second real note does.
                if (storePath) {
                    files.add(storePath);
                    const stored = Buffer.concat(entry ? entry.received : []);
                    record.contents.set(storePath, stored);
                    if (entry) entry.data = stored;
                    record.order.push(`stored:${storePath}`);
                }
                socket.send('DONE');
            }
        });
    });

    return {
        httpPort: httpServer.address().port,
        wsPort: wss.address().port,
        record,
        /** Snapshot of the mock SD card's file paths. */
        files: () => [...files],
        hasFile: (p) => files.has(p),
        /** Stored bytes of a path as text, or null when nothing is stored there. */
        textAt: (p) => (record.contents.has(p) ? record.contents.get(p).toString('utf8') : null),
        /** The record.uploads entry for a stored filename, or undefined. */
        uploadOf: (name) => record.uploads.find((u) => u.name === name),
        /** Let a withheld-PROGRESS mock start acking again, flushing one PROGRESS now. */
        releaseWithTotal(total) {
            releaseProgress = true;
            for (const client of wss.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    record.progressSent += 1;
                    client.send(`PROGRESS:${record.receivedBytes}:${total}`);
                }
            }
        },
        async close() {
            for (const client of wss.clients) client.terminate();
            await new Promise((r) => wss.close(r));
            // A deliberately-stalled /api/files reply can still be pending; drop
            // its socket so close() cannot hang the self-test.
            httpServer.closeAllConnections?.();
            await new Promise((r) => httpServer.close(r));
        },
    };
}

function makeDummyFrame(size = FRAME_BYTES) {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
    return buf;
}

function parseMultipartFields(contentType, body) {
    const m = /boundary=(.+)$/.exec(contentType ?? '');
    if (!m) return { error: 'no boundary in content-type' };
    const boundary = m[1].trim();
    const text = body.toString('utf8');
    const fields = {};
    const headerCases = [];
    for (const rawPart of text.split(`--${boundary}`)) {
        const part = rawPart.replace(/^\r\n/, '');
        if (!part || part.startsWith('--')) continue;
        const split = part.indexOf('\r\n\r\n');
        if (split < 0) continue;
        const headers = part.slice(0, split);
        const value = part.slice(split + 4).replace(/\r\n$/, '');
        const nameMatch = /name="([^"]*)"/.exec(headers);
        if (!nameMatch) continue;
        fields[nameMatch[1]] = value;
        const caseMatch = /^([Cc]ontent-[Dd]isposition)\s*:/m.exec(headers);
        if (caseMatch) headerCases.push(caseMatch[1]);
        if (/^Content-Length:\s*(\d+)/m.test(headers)) {
            fields[`${nameMatch[1]}#len`] = Number(/^Content-Length:\s*(\d+)/m.exec(headers)[1]);
        }
    }
    return { fields, headerCases, boundary };
}

function makeAsserter() {
    const results = [];
    return {
        check(name, condition, detail = '') {
            results.push({ name, ok: Boolean(condition), detail });
            const tag = condition ? 'PASS' : 'FAIL';
            process.stdout.write(`  ${tag}  ${name}${detail ? `  ${detail}` : ''}\n`);
        },
        eq(name, actual, expected) {
            const ok = Object.is(actual, expected);
            this.check(name, ok, ok ? `(${JSON.stringify(actual)})` : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        },
        get failures() { return results.filter((r) => !r.ok); },
        get total() { return results.length; },
    };
}

async function runSelfTest({ debug = false } = {}) {
    const t = makeAsserter();
    const log = makeLogger({ quiet: !debug, debug });

    // -- T1: happy path, exact frame size ------------------------------------
    process.stdout.write('\nT1  happy path: 52272-byte frame -> /.love-notes/current.frame\n');
    {
        const mock = await startMockDevice({ listing: [] });   // empty root -> mkdir must run
        const frame = makeDummyFrame(FRAME_BYTES);
        const data = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);

        const result = await sendFrame({
            host: '127.0.0.1', wsPort: mock.wsPort, httpPort: mock.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
        });

        t.check('upload succeeded', result.ok, result.ok ? '' : `stage=${result.stage} error=${result.error}`);

        // FRAME-SCOPED, not cumulative: the same send also writes the 21-byte
        // current.id sidecar, and reading the shared counters here would let that
        // file quietly move the frame's own numbers.
        const frameUp = mock.record.uploads[0];
        t.eq('START line is byte-exact', frameUp?.startLine, `START:${DEFAULT_NAME}:${FRAME_BYTES}:${DEFAULT_DEVICE_PATH}`);
        t.eq('frame bytes received', frameUp?.bytes, FRAME_BYTES);
        t.eq('chunk count', frameUp?.chunkSizes.length, 13);
        t.check('first 12 chunks are 4096 B',
            (frameUp?.chunkSizes ?? []).slice(0, 12).every((n) => n === CHUNK_SIZE),
            `sizes=${JSON.stringify(frameUp?.chunkSizes)}`);
        t.eq('final chunk is the 3120-byte remainder', frameUp?.chunkSizes[12], FRAME_BYTES - 12 * CHUNK_SIZE);
        t.check('reassembled bytes are identical to the source',
            Buffer.concat(frameUp?.received ?? []).equals(frame));

        // Delete-before-upload is ON by default for BOTH slots, even on a virgin
        // device where there is nothing to remove (T7 covers the ordering and the
        // rejection, T8 the sidecar's own contract).
        t.eq('two pre-upload deletes were issued (id + frame)', mock.record.deletes.length, 2);
        t.eq('the id slot is cleared first', mock.record.deletes[0]?.path, `${DEFAULT_DEVICE_PATH}/${DEFAULT_ID_NAME}`);
        t.eq('then the frame slot', mock.record.deletes[1]?.path, `${DEFAULT_DEVICE_PATH}/${DEFAULT_NAME}`);
        t.check('a delete of a missing file did not fail the send', result.ok);

        // The sidecar: written second, containing exactly the reported id.
        t.eq('two files were uploaded', mock.record.uploads.length, 2);
        t.eq('the second file is the id sidecar', mock.record.uploads[1]?.name, DEFAULT_ID_NAME);
        t.check('the send reports the id it staged', result.idStaged === true && typeof result.noteId === 'string',
            `idStaged=${result.idStaged} noteId=${result.noteId}`);
        t.eq('sidecar contents are the bare id', mock.textAt(`${DEFAULT_DEVICE_PATH}/${DEFAULT_ID_NAME}`), result.noteId);
        t.eq('sidecar START line declares the id length', mock.record.uploads[1]?.startLine,
            `START:${DEFAULT_ID_NAME}:${result.noteId?.length}:${DEFAULT_DEVICE_PATH}`);

        const listReq = mock.record.httpRequests.find((r) => r.path === '/api/files');
        t.eq('list check method', listReq?.method, 'GET');
        t.eq("list check queried parent dir '/'", listReq?.query, '/');

        const mkdirReq = mock.record.httpRequests.find((r) => r.path === '/mkdir');
        t.eq('mkdir method', mkdirReq?.method, 'POST');
        t.check('mkdir content-type is multipart/form-data with a boundary',
            /^multipart\/form-data; boundary=[0-9a-f-]{36}$/.test(mkdirReq?.contentType ?? ''),
            `(${mkdirReq?.contentType})`);
        const parsed = parseMultipartFields(mkdirReq?.contentType, mkdirReq?.body ?? Buffer.alloc(0));
        t.eq('mkdir field name', parsed.fields?.name, '.love-notes');
        t.eq('mkdir field path', parsed.fields?.path, '/');
        t.eq('mkdir part carries okhttp-style Content-Length', parsed.fields?.['name#len'], '.love-notes'.length);
        // RN's FormData.js:86 authors this key lowercase and okhttp keeps the case.
        t.eq('mkdir part header spelling is RN/okhttp-exact', parsed.headerCases?.[0], 'content-disposition');

        await mock.close();
    }

    // -- T1b: --mkdir-canonical-header escape hatch ---------------------------
    process.stdout.write('\nT1b --mkdir-canonical-header emits the canonical spelling\n');
    {
        const mock = await startMockDevice({ listing: [] });
        const res = await ensureFolderExists({
            host: '127.0.0.1', httpPort: mock.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, log, canonicalHeader: true,
        });
        t.check('mkdir accepted', res.ok);
        const mkdirReq = mock.record.httpRequests.find((r) => r.path === '/mkdir');
        const parsed = parseMultipartFields(mkdirReq?.contentType, mkdirReq?.body ?? Buffer.alloc(0));
        t.eq('part header spelling', parsed.headerCases?.[0], 'Content-Disposition');
        t.eq('field name still parses', parsed.fields?.name, '.love-notes');
        await mock.close();
    }

    // -- T2: 128KB in-flight window ------------------------------------------
    process.stdout.write('\nT2  flow control: client must stall at the 128KB unacked window\n');
    {
        const total = 300000;
        const mock = await startMockDevice({ listing: [{ name: '.love-notes', isDirectory: true }], progressMode: 'withhold' });
        const payload = makeDummyFrame(total);
        const data = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);

        const upload = sendFrame({
            host: '127.0.0.1', wsPort: mock.wsPort, httpPort: mock.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: 'big.bin', data, log,
        });

        // Poll instead of sampling at a fixed delay: the client needs ~80ms of
        // mandatory 10ms yields to fill the window, and the 1000ms ACK_FALLBACK_MS
        // then releases it, so a single fixed sample is coupled to wall-clock load.
        // Polling for "reached the window" is the same guarantee, uncoupled.
        // The ceiling assertion below is what proves it never OVERSHOOTS.
        const windowDeadline = Date.now() + 900;
        let stalledAt = mock.record.receivedBytes;
        while (stalledAt < MAX_IN_FLIGHT && Date.now() < windowDeadline) {
            await new Promise((r) => setTimeout(r, 10));
            stalledAt = mock.record.receivedBytes;
        }
        t.check('never exceeds the 128KB window before an ack', stalledAt <= MAX_IN_FLIGHT, `(sent ${stalledAt} B)`);
        t.eq('stalls exactly at the full window', stalledAt, MAX_IN_FLIGHT);

        mock.releaseWithTotal(total);
        const result = await upload;
        t.check('upload completes once acks resume', result.ok, result.ok ? '' : `error=${result.error}`);
        t.eq('all bytes received', mock.record.receivedBytes, total);
        t.check('payload intact after the stall', Buffer.concat(mock.record.received).equals(payload));
        t.check('no mkdir issued when the folder is already listed',
            !mock.record.httpRequests.some((r) => r.path === '/mkdir'));

        await mock.close();
    }

    // -- T3: device ERROR: --------------------------------------------------
    process.stdout.write('\nT3  device error: ERROR:<reason> after START\n');
    {
        const mock = await startMockDevice({ listing: [], wsBehavior: 'error-on-start', errorText: 'no space left on device' });
        const frame = makeDummyFrame(FRAME_BYTES);
        const data = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
        const result = await sendFrame({
            host: '127.0.0.1', wsPort: mock.wsPort, httpPort: mock.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
        });
        t.check('upload reported as failed', result.ok === false);
        t.eq('failure stage', result.stage, 'upload');
        t.eq("'ERROR:' prefix stripped like the app does", result.error, 'no space left on device');
        t.eq('classified as a device error (not a network one)', result.kind, 'device');
        await mock.close();
    }

    // -- T3b: handshake timeout (no READY) -----------------------------------
    process.stdout.write('\nT3b handshake timeout: device opens :81 but never sends READY\n');
    {
        const mock = await startMockDevice({ listing: [], wsBehavior: 'silent' });
        const frame = makeDummyFrame(FRAME_BYTES);
        const data = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
        const started = Date.now();
        const result = await sendFrame({
            host: '127.0.0.1', wsPort: mock.wsPort, httpPort: mock.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
            handshakeTimeoutMs: 300,   // the CLI uses 10000; shortened so the test is fast
        });
        const elapsed = Date.now() - started;
        t.check('upload reported as failed', result.ok === false);
        t.eq('timed out in the handshake phase', result.phase, 'handshake');
        t.eq('classified as timeout', result.kind, 'timeout');
        t.check('gave up at the handshake deadline, not the 5-minute upload timeout',
            elapsed < 3000, `(${elapsed}ms)`);
        t.check('not reported as unreachable (socket did open)', result.unreachable === false);
        t.check('no bytes were streamed', mock.record.receivedBytes === 0);
        await mock.close();
    }

    // -- T4: --verify --------------------------------------------------------
    // A fixed --id, so the expected sidecar SIZE in the listing is not coupled to
    // the minter's current field widths.
    const VERIFY_ID = 'selftest-verify-id';
    process.stdout.write('\nT4  verify: /api/files listing is checked for name + size, for BOTH files\n');
    {
        const good = await startMockDevice({
            listing: (path) => (path === '/' ? [] : [
                { name: DEFAULT_NAME, isDirectory: false, size: FRAME_BYTES },
                { name: DEFAULT_ID_NAME, isDirectory: false, size: VERIFY_ID.length },
            ]),
        });
        const frame = makeDummyFrame(FRAME_BYTES);
        const data = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
        const okResult = await sendFrame({
            host: '127.0.0.1', wsPort: good.wsPort, httpPort: good.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log, verify: true, settleMs: 0,
            noteId: VERIFY_ID,
        });
        t.check('verify passes when name + size match', okResult.ok, okResult.ok ? '' : `stage=${okResult.stage} error=${okResult.error}`);
        const verifyReq = good.record.httpRequests.filter((r) => r.path === '/api/files').at(-1);
        t.eq('verify listed the target folder', verifyReq?.query, DEFAULT_DEVICE_PATH);
        t.eq('the sidecar was verified too, at its own size', okResult.verifyId?.size, VERIFY_ID.length);
        await good.close();

        const bad = await startMockDevice({
            listing: (path) => (path === '/' ? [] : [{ name: DEFAULT_NAME, isDirectory: false, size: 999 }]),
        });
        const badResult = await sendFrame({
            host: '127.0.0.1', wsPort: bad.wsPort, httpPort: bad.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log, verify: true, settleMs: 0,
        });
        t.check('verify fails on a size mismatch', badResult.ok === false && badResult.stage === 'verify',
            `(${badResult.error})`);
        await bad.close();

        // A frame that verifies while its id is MISSING is precisely the state
        // that re-shows the note on every wake, so --verify must not call it OK.
        const noId = await startMockDevice({
            listing: (path) => (path === '/' ? [] : [{ name: DEFAULT_NAME, isDirectory: false, size: FRAME_BYTES }]),
        });
        const noIdResult = await sendFrame({
            host: '127.0.0.1', wsPort: noId.wsPort, httpPort: noId.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log, verify: true, settleMs: 0,
            noteId: VERIFY_ID,
        });
        t.eq('verify fails when only the frame is listed', noIdResult.stage, 'verify-id');
        t.check('and it says which file is missing', /current\.id/.test(noIdResult.error ?? ''), `(${noIdResult.error})`);
        await noId.close();
    }

    // -- T5: unreachable host -----------------------------------------------
    process.stdout.write('\nT5  unreachable: nothing listening -> exit code 3 path\n');
    {
        const frame = makeDummyFrame(FRAME_BYTES);
        const data = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
        // Bind, capture the ports, then shut down: guarantees ECONNREFUSED on
        // ports that are not on the WHATWG "bad port" blocklist.
        const dead = await startMockDevice({ listing: [] });
        const { httpPort, wsPort } = dead;
        await dead.close();

        const result = await sendFrame({
            host: '127.0.0.1', wsPort, httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
        });
        t.check('reports failure', result.ok === false);
        t.eq('fails at the mkdir/reachability preflight', result.stage, 'mkdir');
        t.check('flagged unreachable (drives exit code 3)', result.unreachable === true, `(${result.error})`);

        // And when only :81 is down, the WS connect failure must also be unreachable.
        const httpOnly = await startMockDevice({ listing: [{ name: '.love-notes', isDirectory: true }] });
        const wsResult = await sendFrame({
            host: '127.0.0.1', wsPort, httpPort: httpOnly.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
        });
        t.eq('WS-down failure is attributed to the upload stage', wsResult.stage, 'upload');
        t.eq('WS-down failure is in the connect phase', wsResult.phase, 'connect');
        t.check('WS-down failure is flagged unreachable', wsResult.unreachable === true, `(${wsResult.error})`);
        await httpOnly.close();
    }

    // -- T5b: a SLOW device is not an ABSENT device --------------------------
    // Regression guard: a /api/files that times out must not be reported as
    // "unreachable". The app swallows the failed list check and uploads anyway
    // (crosspoint_upload.ts:265-268); a busy ESP32-C3 can exceed the 5s deadline
    // on a device that accepts the upload perfectly well.
    process.stdout.write('\nT5b slow /api/files: list timeout must NOT abort the upload\n');
    {
        const mock = await startMockDevice({ listing: [], listDelayMs: 600 });
        const frame = makeDummyFrame(FRAME_BYTES);
        const data = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
        const result = await sendFrame({
            host: '127.0.0.1', wsPort: mock.wsPort, httpPort: mock.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
            listTimeoutMs: 200,   // the CLI uses 5000; shortened so the test is fast
        });
        t.check('upload still succeeded', result.ok, result.ok ? '' : `stage=${result.stage} error=${result.error}`);
        t.check('not flagged unreachable', result.unreachable !== true);
        t.eq('all frame bytes reached the device', mock.uploadOf(DEFAULT_NAME)?.bytes, FRAME_BYTES);
        t.check('the timed-out list check was recorded, not silently dropped',
            (result.folder?.steps ?? []).some((s) => s.action === 'list-failed' && s.kind === 'timeout'),
            JSON.stringify(result.folder?.steps));
        t.check('mkdir still ran after the failed list check',
            mock.record.httpRequests.some((r) => r.path === '/mkdir'));
        await mock.close();
    }

    // -- T5c: an untolerated /mkdir status must not block the pipe -----------
    // uploadToCrossPoint (crosspoint_upload.ts:187) discards the boolean from
    // ensureFolderExistsCrossPoint, so the app uploads regardless of the status.
    process.stdout.write('\nT5c /mkdir 403: app-faithful default uploads anyway; --strict-mkdir stops\n');
    {
        const mock = await startMockDevice({ listing: [], mkdirStatus: 403 });
        const frame = makeDummyFrame(FRAME_BYTES);
        const data = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
        const result = await sendFrame({
            host: '127.0.0.1', wsPort: mock.wsPort, httpPort: mock.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
        });
        t.check('upload still succeeded', result.ok, result.ok ? '' : `stage=${result.stage} error=${result.error}`);
        t.eq('all frame bytes reached the device', mock.uploadOf(DEFAULT_NAME)?.bytes, FRAME_BYTES);
        t.check('the 403 was surfaced as a warning',
            (result.folder?.warnings ?? []).some((w) => w.includes('403')),
            JSON.stringify(result.folder?.warnings));
        await mock.close();

        const strict = await startMockDevice({ listing: [], mkdirStatus: 403 });
        const strictResult = await sendFrame({
            host: '127.0.0.1', wsPort: strict.wsPort, httpPort: strict.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
            strictMkdir: true,
        });
        t.check('--strict-mkdir reports failure', strictResult.ok === false);
        t.eq('--strict-mkdir fails at the mkdir stage', strictResult.stage, 'mkdir');
        t.check('--strict-mkdir is not an unreachability claim', strictResult.unreachable === false);
        t.eq('--strict-mkdir streamed nothing', strict.record.receivedBytes, 0);
        await strict.close();
    }

    // -- T7: delete BEFORE upload -------------------------------------------
    // The firmware will not overwrite an existing path. The mock enforces that
    // rule, so these checks fail for the same reason a real re-send would.
    const FRAME_PATH = `${DEFAULT_DEVICE_PATH}/${DEFAULT_NAME}`;
    const ID_PATH = `${DEFAULT_DEVICE_PATH}/${DEFAULT_ID_NAME}`;
    process.stdout.write('\nT7  delete-before-upload: the firmware refuses to overwrite\n');
    {
        const mock = await startMockDevice({
            listing: [{ name: '.love-notes', isDirectory: true }],
            // A previous note AND its id are already on the SD card.
            existingFiles: [FRAME_PATH, ID_PATH],
        });
        const frame = makeDummyFrame(FRAME_BYTES);
        const data = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);

        const result = await sendFrame({
            host: '127.0.0.1', wsPort: mock.wsPort, httpPort: mock.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
        });

        t.check('re-send over an existing note succeeded', result.ok,
            result.ok ? '' : `stage=${result.stage} error=${result.error}`);

        const del = mock.record.httpRequests.filter((r) => r.path === '/delete')
            .find((r) => new URLSearchParams(r.body?.toString('utf8') ?? '').get('path') === FRAME_PATH);
        t.eq('delete method', del?.method, 'POST');
        t.eq('delete content-type', del?.contentType, 'application/x-www-form-urlencoded');
        const form = new URLSearchParams(del?.body?.toString('utf8') ?? '');
        t.eq('delete field path', form.get('path'), FRAME_PATH);
        t.eq('delete field type', form.get('type'), 'file');
        t.check('both existing files were actually removed',
            mock.record.deletes.length === 2 && mock.record.deletes.every((d) => d.existed === true),
            JSON.stringify(mock.record.deletes));

        // ORDER, not just presence: the delete must precede the START line.
        const iDelete = mock.record.order.indexOf(`delete:${FRAME_PATH}`);
        const iStart = mock.record.order.indexOf(`start:${FRAME_PATH}`);
        t.check('delete was issued before the WS START', iDelete >= 0 && iStart >= 0 && iDelete < iStart,
            `order=${JSON.stringify(mock.record.order)}`);
        t.eq('all frame bytes reached the device', mock.uploadOf(DEFAULT_NAME)?.bytes, FRAME_BYTES);
        t.check('the new note is on the device afterwards', mock.hasFile(FRAME_PATH));
        t.check('and so is its new id', mock.hasFile(ID_PATH));
        t.eq('the id on the card is the one reported', mock.textAt(ID_PATH), result.noteId);

        await mock.close();
    }

    // -- T7b: --no-delete must FAIL on an existing file ----------------------
    // If this ever passes, the mock has stopped enforcing the rejection and
    // every ordering assertion above becomes decorative.
    process.stdout.write('\nT7b --no-delete over an existing file must be rejected by the device\n');
    {
        const mock = await startMockDevice({
            listing: [{ name: '.love-notes', isDirectory: true }],
            existingFiles: [FRAME_PATH],
        });
        const frame = makeDummyFrame(FRAME_BYTES);
        const data = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);

        const result = await sendFrame({
            host: '127.0.0.1', wsPort: mock.wsPort, httpPort: mock.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
            deleteFirst: false,
        });

        t.check('upload reported as failed', result.ok === false);
        t.eq('failure stage', result.stage, 'upload');
        t.eq('classified as a device error', result.kind, 'device');
        t.eq("firmware's exists-rejection surfaced verbatim", result.error, 'File already exists');
        t.eq('no delete was issued', mock.record.deletes.length, 0);
        t.eq('not one byte was streamed', mock.record.receivedBytes, 0);
        // A frame that never landed must not get an id: an id naming a note whose
        // frame is not there makes the reader mark it shown while displaying the
        // OLD frame, so the note being sent could never appear at all.
        t.eq('no id sidecar was attempted', mock.record.uploads.filter((u) => u.name === DEFAULT_ID_NAME).length, 0);
        t.check('nothing is stored on the card', mock.textAt(ID_PATH) === null);
        await mock.close();
    }

    // -- T7c: two consecutive sends, the real-world case ---------------------
    // Note 1 lands on a virgin device, note 2 lands on top of note 1. Without
    // the delete, note 2 is the send that silently leaves note 1 on the panel.
    process.stdout.write('\nT7c two consecutive sends both land (the case a missing delete breaks)\n');
    {
        const mock = await startMockDevice({ listing: [{ name: '.love-notes', isDirectory: true }] });
        const first = makeDummyFrame(FRAME_BYTES);
        const second = Buffer.from(first).map((b) => b ^ 0xff);

        const send = (buf) => sendFrame({
            host: '127.0.0.1', wsPort: mock.wsPort, httpPort: mock.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, log,
            data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        });

        const r1 = await send(first);
        t.check('first send succeeded', r1.ok, r1.ok ? '' : `stage=${r1.stage} error=${r1.error}`);
        t.check('nothing existed to delete on the first send',
            mock.record.deletes.slice(0, 2).every((d) => d.existed === false),
            JSON.stringify(mock.record.deletes.slice(0, 2)));

        const r2 = await send(second);
        t.check('second send succeeded', r2.ok, r2.ok ? '' : `stage=${r2.stage} error=${r2.error}`);
        t.check('the second send DID remove the first note and its id',
            mock.record.deletes.slice(2).every((d) => d.existed === true),
            JSON.stringify(mock.record.deletes.slice(2)));

        t.eq('four deletes (id+frame, twice), four uploads', mock.record.deletes.length, 4);
        t.eq('four uploads', mock.record.uploads.length, 4);
        t.eq('both frames were streamed in full',
            mock.record.uploads.filter((u) => u.name === DEFAULT_NAME).reduce((n, u) => n + u.bytes, 0),
            FRAME_BYTES * 2);
        t.check('the device ended up holding the SECOND frame',
            (mock.record.contents.get(FRAME_PATH) ?? Buffer.alloc(0)).equals(second));
        t.check('and the SECOND id', mock.textAt(ID_PATH) === r2.noteId && r2.noteId !== r1.noteId,
            `id1=${r1.noteId} id2=${r2.noteId} card=${mock.textAt(ID_PATH)}`);
        // THE ordering assertion: per send, both slots are cleared, then the frame
        // is stored, and only then does an id appear. Any other interleaving is one
        // of the three silent failures in the file header.
        t.eq('strict delete/start/stored interleaving',
            mock.record.order.join(' '),
            [
                `delete:${ID_PATH}`, `delete:${FRAME_PATH}`,
                `start:${FRAME_PATH}`, `stored:${FRAME_PATH}`,
                `start:${ID_PATH}`, `stored:${ID_PATH}`,
                `delete:${ID_PATH}`, `delete:${FRAME_PATH}`,
                `start:${FRAME_PATH}`, `stored:${FRAME_PATH}`,
                `start:${ID_PATH}`, `stored:${ID_PATH}`,
            ].join(' '));

        await mock.close();
    }

    // -- T8: the id sidecar --------------------------------------------------
    process.stdout.write('\nT8  id sidecar: frame-then-id, contents, and the opt-outs\n');
    {
        // --id is staged verbatim, and it is the LAST thing written.
        const pinned = await startMockDevice({ listing: [{ name: '.love-notes', isDirectory: true }] });
        const frame = makeDummyFrame(FRAME_BYTES);
        const data = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
        const pinnedResult = await sendFrame({
            host: '127.0.0.1', wsPort: pinned.wsPort, httpPort: pinned.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
            noteId: 'note.selftest_1~a-B',
        });
        t.check('send with --id succeeded', pinnedResult.ok, pinnedResult.ok ? '' : `stage=${pinnedResult.stage} error=${pinnedResult.error}`);
        t.eq('the pinned id is what reaches the card', pinned.textAt(ID_PATH), 'note.selftest_1~a-B');
        t.eq('no trailing newline, no padding', pinned.record.contents.get(ID_PATH)?.length, 'note.selftest_1~a-B'.length);
        t.eq('the id is the last file stored', pinned.record.order.at(-1), `stored:${ID_PATH}`);
        await pinned.close();

        // --no-id: the legacy id-less frame, but the OLD id is still cleared —
        // leaving it would suppress the new note outright instead of re-showing it.
        const legacy = await startMockDevice({
            listing: [{ name: '.love-notes', isDirectory: true }],
            existingFiles: [FRAME_PATH, ID_PATH],
        });
        const legacyResult = await sendFrame({
            host: '127.0.0.1', wsPort: legacy.wsPort, httpPort: legacy.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
            stageId: false,
        });
        t.check('--no-id send succeeded', legacyResult.ok, legacyResult.ok ? '' : `stage=${legacyResult.stage} error=${legacyResult.error}`);
        t.check('--no-id reports no id', legacyResult.idStaged === false && legacyResult.noteId === null);
        t.eq('--no-id still deleted the old id', legacy.record.deletes.filter((d) => d.path === ID_PATH && d.existed).length, 1);
        t.check('--no-id left no id on the card', !legacy.hasFile(ID_PATH));
        t.eq('--no-id uploaded only the frame', legacy.record.uploads.length, 1);
        await legacy.close();

        // A non-default --name must not get a sidecar at ALL: current.id beside a
        // frame stored under another name describes a note the firmware cannot
        // find, and marking that id shown suppresses the real note when it lands.
        const renamed = await startMockDevice({
            listing: [{ name: '.love-notes', isDirectory: true }],
            existingFiles: [ID_PATH],
        });
        const renamedResult = await sendFrame({
            host: '127.0.0.1', wsPort: renamed.wsPort, httpPort: renamed.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: 'B-portrait.frame', data, log,
        });
        t.check('send under another name succeeded', renamedResult.ok, renamedResult.ok ? '' : `stage=${renamedResult.stage} error=${renamedResult.error}`);
        t.eq('no sidecar was uploaded', renamed.record.uploads.filter((u) => u.name === DEFAULT_ID_NAME).length, 0);
        t.check("and the unrelated current.id was left alone", renamed.hasFile(ID_PATH));
        t.eq('only the frame slot was cleared', renamed.record.deletes.length, 1);
        await renamed.close();

        // A REFUSED sidecar: the frame lands, the id does not (here through the
        // mock's own exists-rejection, with --no-delete leaving the old id in
        // place). Reported as a failure, with the frame's arrival already logged.
        const halfWritten = await startMockDevice({
            listing: [{ name: '.love-notes', isDirectory: true }],
            existingFiles: [ID_PATH],
        });
        const halfResult = await sendFrame({
            host: '127.0.0.1', wsPort: halfWritten.wsPort, httpPort: halfWritten.httpPort,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, data, log,
            deleteFirst: false,
        });
        t.check('a refused sidecar fails the run', halfResult.ok === false);
        t.eq('failure stage names the sidecar', halfResult.stage, 'upload-id');
        t.eq('classified as a device error', halfResult.kind, 'device');
        t.check('the frame did land', halfWritten.hasFile(FRAME_PATH));
        t.check('idStaged is false', halfResult.idStaged === false);
        await halfWritten.close();
    }

    // -- T8b: ids the reader can actually use --------------------------------
    // Mirror of `trimId`, crosspoint-reader src/network/MessageSync.cpp:36-43: it
    // pops TRAILING \n \r space tab, strips LEADING space and tab only, and
    // silently resize()s past MAX_ID_LEN (:34). The asymmetry is why the sidecar
    // is written with no surrounding whitespace at all, and the silent truncation
    // is why the length is validated here instead of being left to the device.
    const trimIdLikeFirmware = (value) => {
        let out = String(value);
        while (out.length > 0 && ['\n', '\r', ' ', '\t'].includes(out[out.length - 1])) out = out.slice(0, -1);
        let start = 0;
        while (start < out.length && (out[start] === ' ' || out[start] === '\t')) start += 1;
        out = out.slice(start);
        return out.length > NOTE_ID_MAX_CHARS ? out.slice(0, NOTE_ID_MAX_CHARS) : out;
    };
    process.stdout.write('\nT8b minted ids survive the firmware trimId unchanged\n');
    {
        const ids = Array.from({ length: 500 }, () => mintNoteId());
        t.eq('500 mints, 500 distinct ids', new Set(ids).size, 500);
        t.check('every id matches the app minter shape',
            ids.every((id) => /^[0-9a-z]{9}-[0-9a-z]{11}$/.test(id)), `e.g. ${ids[0]}`);
        t.check('every id is unchanged by trimId',
            ids.every((id) => trimIdLikeFirmware(Buffer.from(id, 'ascii').toString('utf8')) === id));
        t.check('every id is accepted by the validator', ids.every((id) => describeNoteIdProblem(id) === null));

        const id = ids[0];
        t.eq('a trailing newline WOULD be tolerated (so one is merely pointless)', trimIdLikeFirmware(`${id}\n`), id);
        t.check('a LEADING newline would NOT be (so nothing is padded)', trimIdLikeFirmware(`\n${id}`) !== id);
        t.eq('an over-long id is silently truncated, never rejected',
            trimIdLikeFirmware('x'.repeat(NOTE_ID_MAX_CHARS + 5)).length, NOTE_ID_MAX_CHARS);
        t.eq('so the validator rejects it first', typeof describeNoteIdProblem('x'.repeat(NOTE_ID_MAX_CHARS + 1)), 'string');
        t.eq('at exactly MAX_ID_LEN it is fine', describeNoteIdProblem('x'.repeat(NOTE_ID_MAX_CHARS)), null);
        for (const bad of ['', 'has space', 'has\nnewline', 'slash/es', 'quote"s']) {
            t.eq(`rejected: ${JSON.stringify(bad)}`, typeof describeNoteIdProblem(bad), 'string');
        }
    }

    // -- T8c: CLI flag validation --------------------------------------------
    process.stdout.write('\nT8c --id / --no-id argument handling\n');
    {
        t.eq('--id parses into noteId', parseArgs(['f', '--id', 'abc-1']).noteId, 'abc-1');
        t.eq('--id=value form', parseArgs(['f', '--id=abc-2']).noteId, 'abc-2');
        t.eq('--no-id parses', parseArgs(['f', '--no-id']).noId, true);
        t.eq('default is mint-one', parseArgs(['f']).noteId, null);
        t.eq('default is stage-one', parseArgs(['f']).noId, false);
        // Contradictory flags are a usage error, not a last-one-wins race: the
        // card's state must not depend on argument order.
        t.eq('--id with --no-id exits 2', await runCli(['f', '--id', 'abc', '--no-id']), EXIT_USAGE);
        t.eq('an unusable --id exits 2 before any network', await runCli(['f', '--id', 'has space']), EXIT_USAGE);

        // sendFrame guards the id itself, so an in-process caller cannot get the
        // frame written and only then find out the id is unusable.
        const guarded = await sendFrame({
            host: '127.0.0.1', wsPort: 1, httpPort: 1,
            devicePath: DEFAULT_DEVICE_PATH, name: DEFAULT_NAME, log,
            data: new Uint8Array(FRAME_BYTES), noteId: 'has space',
        });
        t.check('sendFrame rejects a bad id without touching the network',
            guarded.ok === false && guarded.stage === 'upload-id', `(${guarded.error})`);
    }

    // -- T6: pure functions --------------------------------------------------
    process.stdout.write('\nT6  path/host helpers\n');
    t.eq('deviceTargetPath(/.love-notes)', deviceTargetPath('/.love-notes'), '/.love-notes');
    t.eq('deviceTargetPath(.love-notes)', deviceTargetPath('.love-notes'), '/.love-notes');
    t.eq('deviceTargetPath nested', deviceTargetPath('send-to-x4/2026-02-20'), '/send-to-x4/2026-02-20');
    t.eq('normalizeDeviceHost strips scheme+path', normalizeDeviceHost('http://crosspoint.local/files'), 'crosspoint.local');
    t.eq('chunk count for a frame', Math.ceil(FRAME_BYTES / CHUNK_SIZE), 13);
    t.eq('deviceFilePath(/.love-notes, current.frame)', deviceFilePath('/.love-notes', 'current.frame'), '/.love-notes/current.frame');
    t.eq('deviceFilePath at the SD root does not double the slash', deviceFilePath('/', 'sleep.bmp'), '/sleep.bmp');
    // The two firmware-fixed names, from MessageSync.cpp:18-19.
    t.eq('deviceFilePath(/.love-notes, current.id)', deviceFilePath(DEFAULT_DEVICE_PATH, DEFAULT_ID_NAME), '/.love-notes/current.id');

    const failed = t.failures;
    process.stdout.write(`\nself-test: ${t.total - failed.length}/${t.total} checks passed\n`);
    if (failed.length) {
        for (const f of failed) process.stdout.write(`  FAILED: ${f.name} ${f.detail}\n`);
        return EXIT_FAIL;
    }
    process.stdout.write('SELF-TEST OK\n');
    return EXIT_OK;
}

// ---------------------------------------------------------------------------

const code = await runCli(process.argv.slice(2));
process.exitCode = code;
// Nothing should still be pending, but do not let a lingering socket hang the CLI.
setTimeout(() => process.exit(code), 250).unref();
