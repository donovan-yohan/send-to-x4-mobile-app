/**
 * reader_provision — write the mailbox base URL into the reader's own settings
 * over its WiFi-transfer web server, then read it back to prove it stuck.
 *
 * This is the HOST-only step that turns a dormant reader into one that pulls
 * love-notes: the firmware ships `messageSyncEnabled = 0` and
 * `messageSyncUrl = ""`, and at deep-sleep entry `MessageSync::syncBeforeSleep`
 * returns immediately unless BOTH are set (crosspoint-reader
 * src/network/MessageSync.cpp:131-134). Nothing else on the reader can set them
 * — `messageSyncUrl` is a category-less SettingInfo, deliberately hidden from
 * the on-device Settings screen (crosspoint-reader src/SettingsList.h:323-326),
 * so the web API is the ONLY way in.
 *
 * ---------------------------------------------------------------------------
 * WIRE FORMAT — COPIED FROM THE FIRMWARE, NOT GUESSED
 * ---------------------------------------------------------------------------
 * All line numbers below are in the public fork
 * `crosspoint-reader` (branch `messenger`).
 *
 * ROUTES  src/network/CrossPointWebServer.cpp:167-168
 *   GET  /api/settings   -> handleGetSettings
 *   POST /api/settings   -> handlePostSettings
 *
 * GET  (CrossPointWebServer.cpp:1163-1253) streams a JSON **array**; every
 *      entry is `{key, name, category, type, value, ...}`. A TOGGLE reports
 *      `type:"toggle"` with a NUMERIC 0/1 `value` (line 1187-1193); a STRING
 *      reports `type:"string"` with a string `value` (line 1223-1231).
 *
 * POST (CrossPointWebServer.cpp:1255-1330) is **raw JSON in the body**, an
 *      OBJECT keyed by the same `key` strings — NOT form fields:
 *        - line 1256: `if (!server->hasArg("plain"))` -> 400 "Missing JSON body".
 *          ESP32 `WebServer` only fills the pseudo-arg "plain" when the request
 *          content-type is NOT `application/x-www-form-urlencoded`; sending form
 *          encoding here makes the firmware answer 400 even though the bytes are
 *          well-formed. THE CONTENT-TYPE IS PART OF THE CONTRACT.
 *        - line 1263: `deserializeJson(doc, body)` -> 400 "Invalid JSON: ..."
 *        - line 1274: `if (!doc[s.key].is<JsonVariant>()) continue;` — keys that
 *          are ABSENT are skipped, so a partial POST is safe and leaves every
 *          other setting untouched. That is why this module sends exactly two
 *          keys instead of read-modify-writing the whole list (which would
 *          re-write ~50 unrelated settings and risk clobbering a concurrent
 *          on-device edit).
 *        - line 1278: TOGGLE is read as `doc[key].as<int>() ? 1 : 0` — send the
 *          NUMBER 1, matching what GET hands back.
 *        - line 1310-1317: STRING is `strncpy(ptr, val, stringMaxLen - 1)` with a
 *          forced NUL at `stringMaxLen - 1`. TRUNCATION IS SILENT: an over-long
 *          URL still answers 200 and the reader then GETs a mangled host forever.
 *        - line 1326-1329: `SETTINGS.saveToFile()` then 200 text/plain
 *          "Applied N setting(s)". The 200 only means "parsed"; it does NOT mean
 *          the value survived, hence the mandatory read-back below.
 *
 * URL BUDGET  `char messageSyncUrl[128]` (src/CrossPointSettings.h:245) and the
 *      strncpy above forces `[127] = '\0'`, so **127 characters** is the real
 *      ceiling, not 128. The capability-URL secret has to fit inside it.
 *
 * TRAILING SLASHES  `MessageSync.cpp:52-56` strips them before appending
 *      `/latest.txt` and `/current.frame`, so we normalize the same way and
 *      store the canonical form — otherwise the read-back compare would fail on
 *      a purely cosmetic difference.
 */

import { getDeviceBaseUrl } from './settings';
import { MAILBOX_URL_MAX_CHARS, checkMailboxBaseUrl } from './mailbox_client';
import { formatNetworkError } from './network_errors';

/** Firmware setting keys. Must match crosspoint-reader src/SettingsList.h:316,326. */
export const MESSAGE_SYNC_ENABLED_KEY = 'messageSyncEnabled';
export const MESSAGE_SYNC_URL_KEY = 'messageSyncUrl';

/** crosspoint-reader src/network/CrossPointWebServer.cpp:167-168. */
export const READER_SETTINGS_PATH = '/api/settings';

/**
 * Largest mailbox base URL the reader can actually STORE.
 *
 * `char messageSyncUrl[128]` (CrossPointSettings.h:245) minus the NUL that
 * handlePostSettings writes unconditionally at `[stringMaxLen - 1]`
 * (CrossPointWebServer.cpp:1315-1316). One char over and the write still returns
 * 200 with a silently truncated URL — which is why this is enforced on the app
 * side BEFORE the POST, not discovered from the read-back.
 *
 * ALIASED, not re-typed: `checkMailboxBaseUrl` enforces the ceiling, so a second
 * literal here could drift from the one actually applied and this module would
 * then quote a limit it does not use.
 */
export const READER_SYNC_URL_MAX_CHARS = MAILBOX_URL_MAX_CHARS;

/**
 * Appended to every "cannot talk to the reader" error. The single most common
 * cause is not a bad URL but a reader that simply is not serving: the web server
 * only runs in WiFi transfer mode, and a sleeping reader has its radio off
 * entirely (HANDOFF.md: "deep sleep = WiFi off = invisible").
 */
export const TRANSFER_MODE_HINT =
    'Wake the reader and put it in WiFi transfer mode, then check the device host/IP in Settings.';

const REQUEST_TIMEOUT_MS = 8000;

/** The two fields this module owns, decoded from the reader's settings list. */
export interface ReaderSyncSettings {
    messageSyncEnabled: boolean;
    messageSyncUrl: string;
}

export interface ReaderSyncReadResult {
    ok: boolean;
    error?: string;
    settings?: ReaderSyncSettings;
}

export interface ProvisionReaderResult {
    ok: boolean;
    error?: string;
    /** What the reader reported AFTER the write. Present only when ok. */
    verified?: ReaderSyncSettings;
    /** What the reader reported BEFORE the write, when it could be read. */
    previous?: ReaderSyncSettings;
    /** Parsed out of the firmware's "Applied N setting(s)" reply, when present. */
    applied?: number;
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

type FetchLike = (input: string, init?: any) => Promise<any>;

let fetchImpl: FetchLike | null = null;

/**
 * Swap the HTTP client. Tests only.
 *
 * Exists so `scripts/reader-provision.test.js` can pin the EXACT bytes and
 * headers that go to the firmware without a device and without touching
 * `globalThis.fetch` (which node's test runner shares between files). Pass null
 * to restore the platform fetch.
 */
export function __setProvisionFetch(fn: FetchLike | null): void {
    fetchImpl = fn;
}

function currentFetch(): FetchLike {
    if (fetchImpl) return fetchImpl;
    const globalFetch = (globalThis as any).fetch;
    if (typeof globalFetch !== 'function') {
        throw new Error('No fetch implementation available');
    }
    return globalFetch.bind(globalThis);
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Canonicalize a mailbox base URL the way the FIRMWARE will.
 *
 * Trims whitespace and strips trailing '/' — `MessageSync.cpp:52-56` pops them
 * before appending the two suffixes, so 'https://x/m/abc/' and 'https://x/m/abc'
 * are the same mailbox to the reader. Storing the stripped form keeps the
 * post-write read-back a pure equality check.
 */
export function normalizeReaderSyncUrl(raw: string): string {
    // Same canonicalisation the validator applies, from the same function, so a
    // URL can never pass validation in one form and be STORED in another.
    return checkMailboxBaseUrl(raw).url;
}

export type ReaderSyncUrlCheck =
    | { ok: true; url: string }
    | { ok: false; error: string };

/**
 * Validate a mailbox base URL against what the reader can store and fetch.
 *
 * Every rejection here is a failure the DEVICE cannot report: an over-long URL
 * is truncated with a 200, and a scheme the firmware's HTTP client cannot open
 * simply makes every sleep-time sync a silent no-op.
 *
 * THE RULES ARE NOT DUPLICATED HERE. `mailbox_client.checkMailboxBaseUrl` is the
 * single validator; this function only supplies the wording for a
 * PROVISIONING screen. The two used to have independent rules and disagreed —
 * `HTTPS://host/m/id` provisioned fine and then could never be published to —
 * which is a failure with no visible symptom at all: the reader polls happily,
 * the app refuses every send, and neither message mentions the other side.
 * READER_SYNC_URL_MAX_CHARS and MAILBOX_URL_MAX_CHARS are the same 127 for the
 * same reason (`char messageSyncUrl[128]` minus its NUL).
 */
export function validateReaderSyncUrl(raw: string): ReaderSyncUrlCheck {
    const { url, defect } = checkMailboxBaseUrl(raw);

    switch (defect) {
        case null:
            return { ok: true, url };
        case 'empty':
            return {
                ok: false,
                error: 'Mailbox URL is empty. Set the mailbox URL first, then set up reader sync.',
            };
        // HttpDownloader uses `http.begin(url)` with `setInsecure()` for TLS
        // (crosspoint-reader src/network/HttpDownloader.cpp:56): http:// and
        // https:// only. Anything else never opens a connection.
        case 'scheme':
            return {
                ok: false,
                error: `Mailbox URL must start with http:// or https:// (got "${url}"). The reader's HTTP client cannot open any other scheme.`,
            };
        case 'host':
            return {
                ok: false,
                error: `Mailbox URL has no host ("${url}"). The reader would have nothing to connect to.`,
            };
        case 'whitespace':
            return {
                ok: false,
                error: `Mailbox URL must not contain spaces ("${url}").`,
            };
        case 'credentials':
            return {
                ok: false,
                error:
                    'Mailbox URL must not contain a username or password — the reader stores it in ' +
                    'clear and serves it back from its own /api/settings.',
            };
        case 'query':
        case 'fragment':
            // MessageSync.cpp appends "/latest.txt" by string concatenation, so
            // anything after the path turns into a URL that resolves to nothing.
            return {
                ok: false,
                error:
                    `Mailbox URL must not contain a ${defect === 'query' ? 'query string' : '#fragment'} ` +
                    `("${url}"). The reader appends its own path to it.`,
            };
        case 'too-long':
            return {
                ok: false,
                error:
                    `Mailbox URL is ${url.length} characters; the reader stores at most ` +
                    `${READER_SYNC_URL_MAX_CHARS} (messageSyncUrl[128] minus its NUL) and truncates the rest ` +
                    `WITHOUT reporting an error. Shorten the mailbox base URL.`,
            };
        default:
            return { ok: false, error: `Mailbox URL is not usable: "${url}".` };
    }
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

/**
 * The exact JSON object body handlePostSettings expects.
 *
 * Kept as its own function so a test can snapshot the literal bytes: the toggle
 * MUST be numeric (`as<int>()`, CrossPointWebServer.cpp:1278) and only these two
 * keys may appear (absent keys are skipped at line 1274, which is what makes a
 * partial write safe).
 */
export function buildProvisionBody(url: string, enabled: boolean = true): string {
    return JSON.stringify({
        [MESSAGE_SYNC_ENABLED_KEY]: enabled ? 1 : 0,
        [MESSAGE_SYNC_URL_KEY]: url,
    });
}

/**
 * Headers for the settings POST.
 *
 * `application/json` is load-bearing, not decoration — see the module header:
 * ESP32's WebServer hides the body from `arg("plain")` when the content-type is
 * form encoding, and the firmware then 400s at CrossPointWebServer.cpp:1256.
 */
export function provisionRequestHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
}

/**
 * Pull the two message-sync fields out of the firmware's settings array.
 *
 * Returns null when the array does not carry them at all, which is the honest
 * signal for "this reader is running firmware from before message sync" — an
 * important distinction from "the value is off", because provisioning such a
 * reader would report success and then never sync.
 */
export function parseReaderSyncSettings(payload: unknown): ReaderSyncSettings | null {
    if (!Array.isArray(payload)) return null;

    let sawEnabled = false;
    let sawUrl = false;
    let enabled = false;
    let url = '';

    for (const entry of payload) {
        if (!entry || typeof entry !== 'object') continue;
        const key = (entry as any).key;
        const value = (entry as any).value;

        if (key === MESSAGE_SYNC_ENABLED_KEY) {
            sawEnabled = true;
            // Firmware serializes a toggle as a NUMBER (line 1190), but tolerate a
            // boolean/string in case the JSON serializer ever changes shape —
            // guessing wrong here would report a provisioned reader as broken.
            enabled = value === 1 || value === true || value === '1';
        } else if (key === MESSAGE_SYNC_URL_KEY) {
            sawUrl = true;
            url = typeof value === 'string' ? value : '';
        }
    }

    if (!sawEnabled || !sawUrl) return null;
    return { messageSyncEnabled: enabled, messageSyncUrl: url };
}

/** Parse the count out of "Applied 2 setting(s)" (CrossPointWebServer.cpp:1329). */
export function parseAppliedCount(body: string): number | undefined {
    const match = /Applied\s+(\d+)\s+setting/i.exec(body ?? '');
    return match ? Number(match[1]) : undefined;
}

async function timedFetch(url: string, init?: any): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await currentFetch()(url, { ...(init ?? {}), signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Read the reader's current message-sync configuration.
 *
 * NEVER THROWS — every failure comes back as `{ ok: false, error }`, matching
 * every other sender/reader in this repo (love_note_sender, wallpaper_sender),
 * so a caller can render `result.error` without a try/catch.
 */
export async function fetchReaderSyncSettings(readerIp: string): Promise<ReaderSyncReadResult> {
    const requestUrl = `${getDeviceBaseUrl(readerIp)}${READER_SETTINGS_PATH}`;

    let response: any;
    try {
        response = await timedFetch(requestUrl);
    } catch (error) {
        return {
            ok: false,
            error: `Could not reach the reader (${formatNetworkError(error, requestUrl)}). ${TRANSFER_MODE_HINT}`,
        };
    }

    if (!response?.ok) {
        return {
            ok: false,
            error: `Reader answered HTTP ${response?.status ?? '?'} for ${READER_SETTINGS_PATH}. ${TRANSFER_MODE_HINT}`,
        };
    }

    let payload: unknown;
    try {
        payload = await response.json();
    } catch (error) {
        return {
            ok: false,
            error: `Reader settings response was not JSON (${formatNetworkError(error, requestUrl)}). ${TRANSFER_MODE_HINT}`,
        };
    }

    const settings = parseReaderSyncSettings(payload);
    if (!settings) {
        return {
            ok: false,
            error:
                `Reader settings do not include ${MESSAGE_SYNC_ENABLED_KEY}/${MESSAGE_SYNC_URL_KEY}. ` +
                'This reader is running firmware from before message sync — update the reader firmware.',
        };
    }

    return { ok: true, settings };
}

// ---------------------------------------------------------------------------
// Provision
// ---------------------------------------------------------------------------

/**
 * Point a reader at a mailbox and turn sleep-time sync on.
 *
 * Read -> write -> READ BACK. The read-back is the whole point: the firmware
 * answers 200 to a write it silently truncated (over-long URL) and 200 to a
 * write of a key it does not know, so the POST's status code proves nothing.
 * Only a matching re-GET does.
 *
 * The initial read is not just a probe either — it fails loudly on firmware that
 * has no message-sync settings at all, which would otherwise "provision"
 * perfectly and never sync.
 *
 * NEVER THROWS.
 *
 * @param readerIp    Device host or IP (the same value as Settings > Device Host).
 * @param mailboxUrl  Mailbox BASE url ({origin}/m/{boxId}) — never the write token.
 */
export async function provisionReaderSync(
    readerIp: string,
    mailboxUrl: string
): Promise<ProvisionReaderResult> {
    const check = validateReaderSyncUrl(mailboxUrl);
    if (!check.ok) {
        return { ok: false, error: check.error };
    }
    const url = check.url;

    // 1. Read first: proves the reader is serving AND that this firmware knows
    //    the two keys, before we claim to have configured anything.
    const before = await fetchReaderSyncSettings(readerIp);
    if (!before.ok) {
        return { ok: false, error: before.error };
    }
    const previous = before.settings;

    // 2. Partial write — two keys only. Every other setting is skipped by the
    //    firmware's `continue` at CrossPointWebServer.cpp:1274 and left alone.
    const requestUrl = `${getDeviceBaseUrl(readerIp)}${READER_SETTINGS_PATH}`;
    let response: any;
    try {
        response = await timedFetch(requestUrl, {
            method: 'POST',
            headers: provisionRequestHeaders(),
            body: buildProvisionBody(url, true),
        });
    } catch (error) {
        return {
            ok: false,
            previous,
            error: `Could not write reader settings (${formatNetworkError(error, requestUrl)}). ${TRANSFER_MODE_HINT}`,
        };
    }

    let replyText = '';
    try {
        replyText = typeof response?.text === 'function' ? await response.text() : '';
    } catch {
        replyText = '';
    }

    if (!response?.ok) {
        return {
            ok: false,
            previous,
            error:
                `Reader rejected the settings write: HTTP ${response?.status ?? '?'}` +
                (replyText ? ` — ${replyText}` : '') +
                `. ${TRANSFER_MODE_HINT}`,
        };
    }

    const applied = parseAppliedCount(replyText);

    // 3. Read back. A 200 above means "the JSON parsed", nothing more.
    const after = await fetchReaderSyncSettings(readerIp);
    if (!after.ok) {
        return {
            ok: false,
            previous,
            applied,
            error: `Wrote reader settings but could not read them back: ${after.error}`,
        };
    }
    const verified = after.settings!;

    const mismatches: string[] = [];
    if (!verified.messageSyncEnabled) {
        mismatches.push(`${MESSAGE_SYNC_ENABLED_KEY} is still off`);
    }
    if (verified.messageSyncUrl !== url) {
        // The overwhelmingly likely cause is the 127-char truncation, so name it
        // rather than making the user diff two long strings themselves.
        const truncated =
            verified.messageSyncUrl.length < url.length && url.startsWith(verified.messageSyncUrl);
        mismatches.push(
            `${MESSAGE_SYNC_URL_KEY} reads back as "${verified.messageSyncUrl}" ` +
                `(expected "${url}")${truncated ? ' — the reader TRUNCATED it' : ''}`
        );
    }

    if (mismatches.length > 0) {
        return {
            ok: false,
            previous,
            verified,
            applied,
            error: `Reader did not keep the new settings: ${mismatches.join('; ')}.`,
        };
    }

    return { ok: true, previous, verified, applied };
}
