#!/usr/bin/env node
/**
 * LOCAL mailbox dev server — the same `mailbox/src/core.js` the Cloudflare
 * Worker runs, wrapped in a node http server with an in-memory store.
 *
 * Purpose: provision and smoke-test the reader end-to-end on the LAN without a
 * Cloudflare account, and give `scripts/mailbox-core.test.js` a real-socket
 * counterpart when you want one. The reader speaks plain http happily
 * (`HttpDownloader` picks the transport from the URL scheme), so
 * `http://<lan-ip>:<port>/m/<boxId>` is a valid messageSyncUrl.
 *
 *   node scripts/mailbox_dev_server.mjs --port 8790 --token <t> --box <id>
 *
 * All flags are optional; a missing token/box is generated and printed.
 *
 * ---------------------------------------------------------------------------
 * BOUNDEDNESS IS A FEATURE OF THIS FILE. This repo has stalled its host with
 * unbounded node processes before, so this server:
 *   - caps every request body PER ROUTE (`core.js` `requestBodyLimit`): 64 KB
 *     for the note routes (one frame is 52272 B), MAX_BOOK_BYTES for
 *     `POST /books` because an epub genuinely is megabytes, MAX_WALLPAPER_BYTES
 *     for `POST /wallpaper` because a full-bleed 8bpp BMP is ~1.1 MB. Past the
 *     cap the bytes are discarded as they arrive and the request is answered
 *     413 with `Connection: close`, so it can never buffer an attacker-chosen
 *     amount AND the client still learns why it was refused;
 *   - checks the bearer token BEFORE buffering on any route whose cap is above
 *     the notes cap, so knowing the boxId (a READ capability, cleartext by
 *     design) is not enough to make this process allocate 24 MB per request;
 *   - serves exactly ONE box id, so no number of published ids widens it;
 *   - reads a book or wallpaper RANGE straight off the disk (`--data-dir`), so
 *     resuming a 24 MB epub (or a 1.1 MB BMP) costs the size of the window
 *     asked for, not the whole file.
 *     **Prefer `--data-dir` once books or wallpapers are in play**: the
 *     in-memory store keeps every blob resident, so its worst case is
 *     MAX_BOOKS x MAX_BOOK_BYTES (20 x 24 MB) plus
 *     MAX_WALLPAPERS x MAX_WALLPAPER_BYTES (8 x 4 MB) plus one frame, and the
 *     systemd unit on the devbox sets `MemoryMax=256M` — enough for one upload
 *     at a time, not for a library;
 *   - is single-process — no cluster, no worker_threads, no child processes;
 *   - bounds every phase of a connection (headers/request/keep-alive timeouts);
 *   - self-terminates after --ttl seconds (default 1800, max 86400).
 *
 * `--ttl 0` disables ONLY the self-terminate, for runs under a supervisor that
 * owns the lifetime (systemd). Every other bound above still applies, so the
 * process cannot grow — but pair it with --data-dir, or a restart drops the
 * staged note.
 * ---------------------------------------------------------------------------
 */

import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { open, readFile, rename, rm, stat as statFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import {
    FRAME_BYTES,
    MAX_BOOKS,
    MAX_BOOK_BYTES,
    MAX_REQUEST_BODY_BYTES,
    MAX_WALLPAPERS,
    MAX_WALLPAPER_BYTES,
    BOX_ID_PATTERN,
    MIN_WRITE_TOKEN_LEN,
    buildBaseUrl,
    checkReaderUrlBudget,
    createMemoryStore,
    generateBoxId,
    generateWriteToken,
    handleRequest,
    parsePath,
    requestBodyLimit,
    writeAuthPreflight,
} from '../mailbox/src/core.js';

const DEFAULT_PORT = 8790;
const DEFAULT_TTL_SECONDS = 1800;
const MAX_TTL_SECONDS = 86400;

function usage() {
    return [
        'usage: node scripts/mailbox_dev_server.mjs [options]',
        '',
        '  --port <n>     listen port (default 8790)',
        '  --host <addr>  bind address (default 0.0.0.0, so the reader can reach it).',
        '                 For a long-lived/supervised run bind the ONE interface that',
        '                 needs it (LAN or tailnet address) rather than every one.',
        '  --token <t>    write token. Min 16 chars. PREFER $MAILBOX_WRITE_TOKEN:',
        '                 an argv token is world-readable in `ps` for the life of the',
        '                 process. Default: read $MAILBOX_WRITE_TOKEN, else generate.',
        '                 Only a GENERATED token is echoed in the banner.',
        `  --box <id>     box id, ${BOX_ID_PATTERN.source} (default: generated)`,
        '  --data-dir <p> persist the frame + id pointer under this directory',
        '                 (default: in-memory, lost on restart)',
        `  --ttl <secs>   self-terminate after N seconds (default ${DEFAULT_TTL_SECONDS}, max ${MAX_TTL_SECONDS});`,
        '                 0 disables it, for supervised (systemd) runs only',
        '  --quiet        suppress per-request logging',
        '  --help',
    ].join('\n');
}

/**
 * File-backed store: one file per key, written to a temp path and RENAMED into
 * place. The rename is what makes it safe — a torn write must never leave a
 * half-written frame readable, because the reader would download it, fail the
 * 52272-byte check and show nothing. It also preserves the core's frame-then-
 * pointer ordering on disk across a crash.
 */
export function createFileStore(dir) {
    const root = resolvePath(dir);
    mkdirSync(root, { recursive: true });
    const fileFor = (key) => {
        const name = key.replace(/:/g, '_');
        // Belt-and-braces: parsePath has already validated the boxId and
        // handlePublish the note id, but this is the only place a store key
        // becomes a filesystem path. `~` is in NOTE_ID_PATTERN and therefore has
        // to be here too — without it a perfectly legal note id makes the
        // content-addressed frame key throw instead of storing.
        if (!/^[A-Za-z0-9._~-]+$/.test(name)) throw new Error(`refusing unsafe store key: ${key}`);
        return join(root, name);
    };
    return {
        root,
        async get(key) {
            try {
                return new Uint8Array(await readFile(fileFor(key)));
            } catch (err) {
                if (err && err.code === 'ENOENT') return null;
                throw err;
            }
        },
        async put(key, value) {
            const path = fileFor(key);
            const tmp = `${path}.tmp`;
            await writeFile(tmp, value);
            await rename(tmp, path);
        },
        // Publish's GC of superseded frames. `force` so collecting a frame that
        // a crash already removed is a no-op rather than an ENOENT throw.
        async delete(key) {
            await rm(fileFor(key), { force: true });
        },
        // ---------------------------------------------------------------
        // The OPTIONAL half of the store contract, and the whole reason it is
        // optional: with `stat` + `getRange` the core serves a book range by
        // reading ONLY that window off the disk. Without them it would call
        // `get`, which materialises the entire value — up to MAX_BOOK_BYTES
        // (24 MB) per request, in a process that ships with `MemoryMax=256M` in
        // its systemd unit. The ESP32 resumes in small windows, so this is the
        // difference between a bounded and an unbounded footprint on the exact
        // path books exist for.
        // ---------------------------------------------------------------
        async stat(key) {
            try {
                return { bytes: (await statFile(fileFor(key))).size };
            } catch (err) {
                if (err && err.code === 'ENOENT') return null;
                throw err;
            }
        },
        async getRange(key, start, length) {
            if (length === 0) return new Uint8Array(0);
            let handle;
            try {
                handle = await open(fileFor(key), 'r');
            } catch (err) {
                // Vanished between stat and read. null is the core's "not here"
                // and becomes a self-healing 404, not a 500.
                if (err && err.code === 'ENOENT') return null;
                throw err;
            }
            try {
                const buffer = Buffer.allocUnsafe(length);
                const { bytesRead } = await handle.read(buffer, 0, length, start);
                // The core compares this against the length it asked for, so a
                // short read is reported rather than padded with whatever
                // allocUnsafe left in the tail.
                return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
            } finally {
                await handle.close();
            }
        },
    };
}

function die(message) {
    process.stderr.write(`mailbox-dev: ${message}\n\n${usage()}\n`);
    process.exit(2);
}

function parseArgs(argv) {
    const opts = {
        port: DEFAULT_PORT,
        host: '0.0.0.0',
        token: null,
        box: null,
        dataDir: null,
        ttl: DEFAULT_TTL_SECONDS,
        quiet: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) die(`${arg} needs a value`);
            return v;
        };
        switch (arg) {
            case '--help':
            case '-h':
                process.stdout.write(`${usage()}\n`);
                process.exit(0);
                break;
            case '--port':
                opts.port = Number(next());
                break;
            case '--host':
                opts.host = next();
                break;
            case '--token':
                opts.token = next();
                break;
            case '--box':
                opts.box = next();
                break;
            case '--data-dir':
                opts.dataDir = next();
                break;
            case '--ttl':
                opts.ttl = Number(next());
                break;
            case '--quiet':
                opts.quiet = true;
                break;
            default:
                die(`unknown argument: ${arg}`);
        }
    }

    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) die('--port must be 1..65535');
    if (!Number.isInteger(opts.ttl) || opts.ttl < 0 || opts.ttl > MAX_TTL_SECONDS) {
        die(`--ttl must be 0..${MAX_TTL_SECONDS} seconds (0 = supervised, no self-terminate)`);
    }
    if (opts.token !== null && opts.token.length < MIN_WRITE_TOKEN_LEN) {
        die(`--token must be at least ${MIN_WRITE_TOKEN_LEN} chars (core.js refuses to serve behind a weak token)`);
    }
    if (opts.box !== null && !BOX_ID_PATTERN.test(opts.box)) {
        die(`--box must match ${BOX_ID_PATTERN.source}`);
    }
    return opts;
}

/** First non-internal IPv4, so the printed URL is one the reader can actually reach. */
function lanAddress() {
    for (const addrs of Object.values(networkInterfaces())) {
        for (const addr of addrs ?? []) {
            if (addr.family === 'IPv4' && !addr.internal) return addr.address;
        }
    }
    return '127.0.0.1';
}

/**
 * Buffer a request body, hard-capped.
 *
 * The cap is checked as bytes ARRIVE, not from Content-Length, because a client
 * may lie about or omit it. Content-Length is still checked first so an honest
 * oversized upload is rejected before a single byte is buffered.
 *
 * NEVER DESTROYS THE SOCKET ITSELF. Promise resolution is a microtask, so a
 * `req.destroy()` here runs BEFORE the handler's `sendJson(res, 413, …)` can
 * write, and the client sees a bare connection reset (curl 56) instead of the
 * 413 the contract promises — indistinguishable, to the app's
 * `describeNetworkFailure`, from "could not reach the mailbox", i.e. reported as
 * retryable when it is not. Once over the cap the chunks are DISCARDED rather
 * than buffered, which is what actually holds the memory bound; tearing the
 * connection down is the caller's job, after the response is on the wire.
 */
export function readBoundedBody(req, limit) {
    return new Promise((resolve) => {
        const declared = req.headers['content-length'];
        if (declared !== undefined) {
            const n = Number(declared);
            if (!Number.isFinite(n) || n < 0) {
                resolve({ invalid: true });
                return;
            }
            if (n > limit) {
                resolve({ tooLarge: true });
                return;
            }
        }
        const chunks = [];
        let total = 0;
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        req.on('data', (chunk) => {
            if (settled) return; // over the cap already: drain to /dev/null
            total += chunk.length;
            if (total > limit) {
                chunks.length = 0; // release what was buffered before answering
                finish({ tooLarge: true });
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            // Guarded, and ONE allocation. The old body was
            // `new Uint8Array(Buffer.concat(chunks))`, which is three full-size
            // copies of the payload (`chunks`, the concat result, then the
            // Uint8Array copy) — ~72 MiB of peak for a 24 MiB book in a process
            // whose systemd unit sets MemoryMax=256M. Copying into one buffer and
            // dropping each chunk as it lands keeps the peak at 2x decaying to 1x.
            //
            // A `Buffer.concat` VIEW would also drop the third copy, but node's
            // socket chunks come out of a shared allocation pool, so a
            // single-chunk body could hand the store a window onto pooled memory.
            // Copying is the same cost and has no aliasing question.
            //
            // The `settled` guard matters on the books route: without it an
            // already-413'd 24 MiB upload would still allocate `total` bytes here
            // for a request that has been answered and whose chunks are gone.
            if (settled) return;
            const out = new Uint8Array(total);
            let offset = 0;
            for (let i = 0; i < chunks.length; i++) {
                out.set(chunks[i], offset);
                offset += chunks[i].length;
                chunks[i] = null;
            }
            finish({ bytes: out });
        });
        req.on('error', () => finish({ aborted: true }));
        req.on('aborted', () => finish({ aborted: true }));
    });
}

/**
 * Answer 413, then stop the upload — in that order, and without touching the
 * socket by hand.
 *
 * `Connection: close` is the whole mechanism: it marks the response as the
 * last one on this connection, and node's own `resOnFinish`
 * (lib/_http_server.js) then flushes the response, dumps whatever the client is
 * still sending, and calls `destroySoon()` — which destroys only AFTER the
 * pending writes have gone out. Calling `req.destroy()` ourselves races the 413
 * out of the socket buffer, which is how an oversize chunked body used to come
 * back as `curl: (56) Recv failure` with http_code 000.
 */
export function rejectTooLarge(res, limit, error = 'frame_too_large') {
    send(
        res,
        413,
        {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'close',
        },
        JSON.stringify({ ok: false, error, detail: `body exceeds ${limit} bytes` })
    );
}

/**
 * Answer a core response BEFORE the body has been read, then stop the upload.
 *
 * Used for the pre-buffering auth check on `POST /books`. Same `Connection:
 * close` mechanism as {@link rejectTooLarge}, for the same reason and with the
 * same ordering constraint: node flushes this response, dumps whatever the
 * client is still sending and only then destroys the socket. Without the header
 * node would keep the connection alive and DUMP the remaining 24 MiB instead —
 * correct, but it makes the client pay for a body nobody will ever look at.
 *
 * The 401 body is the core's own, byte for byte, so a caller cannot tell whether
 * it was refused before or after the upload.
 */
export function rejectBeforeBody(res, denied) {
    send(res, denied.status, { ...denied.headers, connection: 'close' }, denied.body);
}

function send(res, status, headers, body, { head = false } = {}) {
    const out = { ...headers };
    let buffer = null;
    if (body !== null && body !== undefined) {
        buffer =
            typeof body === 'string'
                ? Buffer.from(body, 'utf8')
                : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
        out['content-length'] = String(buffer.length);
    } else if (!head) {
        delete out['content-length'];
    }
    // A HEAD answer keeps the Content-Length the core computed for the body it is
    // deliberately not sending — that IS what a HEAD reports (RFC 9110), and it
    // is how a client learns a book's size without downloading it. node knows the
    // request method and writes no body, so the two cannot desync. The `head`
    // gate matters because any OTHER null body with a Content-Length would leave
    // a client waiting for bytes that never come.
    res.writeHead(status, out);
    res.end(buffer ?? undefined);
}

function sendJson(res, status, obj) {
    send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(obj));
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const boxId = opts.box ?? generateBoxId();

    // TOKEN SOURCES, worst to best:
    //   --token <t>            world-readable in `ps` for the life of the process
    //   $MAILBOX_WRITE_TOKEN   systemd EnvironmentFile; never in argv
    //   generated              interactive runs only
    // A SUPPLIED token is never echoed either way: a supervised run's stdout is
    // the journal, and a write credential that is valid for EVERY box would
    // outlive the process there by weeks.
    const envToken = typeof process.env.MAILBOX_WRITE_TOKEN === 'string'
        ? process.env.MAILBOX_WRITE_TOKEN.trim()
        : '';
    if (opts.token === null && envToken && envToken.length < MIN_WRITE_TOKEN_LEN) {
        die(`$MAILBOX_WRITE_TOKEN must be at least ${MIN_WRITE_TOKEN_LEN} chars (core.js refuses to serve behind a weak token)`);
    }
    const suppliedToken = opts.token ?? (envToken || null);
    const writeToken = suppliedToken ?? generateWriteToken();
    const tokenIsGenerated = suppliedToken === null;
    const tokenForDisplay = tokenIsGenerated ? writeToken : '$MAILBOX_WRITE_TOKEN';
    const store = opts.dataDir ? createFileStore(opts.dataDir) : createMemoryStore();
    const config = { writeToken };

    const server = createServer((req, res) => {
        void (async () => {
            const started = Date.now();
            try {
                const method = (req.method ?? 'GET').toUpperCase();
                const path = req.url ?? '/';

                // Single-box allowlist. Enforced HERE, not in core.js: the core
                // is the shared production contract (any valid box id is
                // servable) and this bound exists purely so the dev server's
                // memory footprint is one frame, whatever gets published.
                const parsed = parsePath(path);
                if (parsed && parsed.boxId !== boxId) {
                    sendJson(res, 404, { ok: false, error: 'not_found', detail: 'this dev server serves one box id' });
                    return;
                }

                let body = null;
                if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
                    // PER-ROUTE cap, decided by the core: 64 KB everywhere except
                    // `POST /books`, which needs the whole book cap. Asking the
                    // core keeps the notes routes refusing an oversize body off
                    // the socket instead of buffering 24 MB to then reject it.
                    const limit = requestBodyLimit(method, path);

                    // AUTH BEFORE BUFFERING on any route whose cap is above the
                    // notes cap — `POST /books` and `POST /wallpaper`. This is
                    // a PREDICATE, not a route list, which is why the wallpaper
                    // route inherited it for free. `requestBodyLimit` sees
                    // only method+path and so cannot tell a credentialed upload
                    // from an anonymous one; the boxId in the path is a READ
                    // capability that travels in cleartext over plain http by
                    // design, so on its own it must not be enough to make this
                    // process allocate. Measured on a real socket before this
                    // check existed: one unauthenticated 24 MiB `POST /books`
                    // was answered 401 having accepted the whole body, and RSS
                    // peaked +55 MB — four concurrent ones exceed the unit's
                    // MemoryMax=256M and OOM-kill the notes path with it.
                    if (limit.bytes > MAX_REQUEST_BODY_BYTES) {
                        const denied = writeAuthPreflight(req.headers, config);
                        if (denied) {
                            rejectBeforeBody(res, denied);
                            if (!opts.quiet) {
                                process.stdout.write(
                                    `${method} ${path} -> ${denied.status} (pre-body, ${Date.now() - started}ms)\n`
                                );
                            }
                            return;
                        }
                    }

                    const read = await readBoundedBody(req, limit.bytes);
                    if (read.aborted) return;
                    if (read.tooLarge) {
                        rejectTooLarge(res, limit.bytes, limit.error);
                        return;
                    }
                    if (read.invalid) {
                        sendJson(res, 400, { ok: false, error: 'bad_request', detail: 'invalid Content-Length' });
                        return;
                    }
                    body = read.bytes;
                }

                const result = await handleRequest({ method, path, headers: req.headers, body }, store, config);
                send(res, result.status, result.headers, result.body, { head: method === 'HEAD' });
                if (!opts.quiet) {
                    process.stdout.write(`${method} ${path} -> ${result.status} (${Date.now() - started}ms)\n`);
                }
            } catch (err) {
                process.stderr.write(`mailbox-dev: request failed: ${err?.stack ?? err}\n`);
                if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal_error' });
                else res.end();
            }
        })();
    });

    // Bound every phase of a connection so a half-open socket cannot pin the
    // process until the TTL fires.
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;

    server.on('error', (err) => {
        process.stderr.write(`mailbox-dev: server error: ${err.message}\n`);
        process.exit(1);
    });

    await new Promise((resolve) => server.listen(opts.port, opts.host, resolve));

    const lan = lanAddress();
    const baseUrl = buildBaseUrl(`http://${lan}:${opts.port}`, boxId);
    const budget = checkReaderUrlBudget(baseUrl);

    process.stdout.write(
        [
            '',
            'mailbox dev server (single box, bounded)',
            `  listening      http://${opts.host}:${opts.port}`,
            `  box id         ${boxId}`,
            `  write token    ${
                tokenIsGenerated
                    ? writeToken
                    : `(supplied via ${opts.token !== null ? '--token' : '$MAILBOX_WRITE_TOKEN'}; not echoed)`
            }`,
            `  store          ${store.root ? `files under ${store.root}` : 'in-memory (lost on restart)'}`,
            `  frame size     ${FRAME_BYTES} bytes (exact; anything else is rejected)`,
            `  body cap       ${MAX_REQUEST_BODY_BYTES} bytes (notes) / ${MAX_BOOK_BYTES} bytes (POST /books)`,
            `                 / ${MAX_WALLPAPER_BYTES} bytes (POST /wallpaper)`,
            `  books          up to ${MAX_BOOKS} per box, oldest evicted${
                store.root ? ', ranged reads off disk' : ' — IN MEMORY, prefer --data-dir'
            }`,
            `  wallpapers     up to ${MAX_WALLPAPERS} pending per box, oldest evicted;`,
            '                 a new "primary" supersedes the pending one',
            opts.ttl > 0
                ? `  self-terminate in ${opts.ttl}s`
                : '  self-terminate DISABLED (--ttl 0) — run this under a supervisor only',
            '',
            'Provision the reader with EXACTLY this (POST /api/settings messageSyncUrl):',
            `  ${baseUrl}`,
            `  ${budget.length}/${budget.limit} chars${budget.ok ? '' : '  *** TOO LONG — the reader truncates at 127 ***'}`,
            '',
            'Smoke test:',
            `  head -c ${FRAME_BYTES} /dev/urandom > /tmp/frame.bin`,
            `  curl -sS -X POST '${baseUrl}/publish' \\`,
            `    -H 'Authorization: Bearer ${tokenForDisplay}' \\`,
            "    -H 'Content-Type: application/octet-stream' \\",
            "    -H 'X-Note-Id: smoke-1' --data-binary @/tmp/frame.bin",
            `  curl -sS '${baseUrl}/latest.txt'`,
            `  curl -sS '${baseUrl}/current.frame' -o /tmp/out.bin && cmp /tmp/frame.bin /tmp/out.bin`,
            `  curl -sS '${baseUrl}/status' -H 'Authorization: Bearer ${tokenForDisplay}'`,
            '',
            'Books (same box, same token; Range is the reader\'s resume mechanism):',
            `  curl -sS -X POST '${baseUrl}/books' \\`,
            `    -H 'Authorization: Bearer ${tokenForDisplay}' \\`,
            "    -H 'Content-Type: application/octet-stream' \\",
            "    -H 'X-Book-Id: smoke-book-1' -H 'X-Filename: Smoke Test.epub' \\",
            '    --data-binary @/tmp/book.epub',
            `  curl -sS '${baseUrl}/books.txt'`,
            `  curl -sS -r 1024- '${baseUrl}/books/smoke-book-1' -o /tmp/tail.bin -D -`,
            `  curl -sS -X DELETE '${baseUrl}/books/smoke-book-1' -H 'Authorization: Bearer ${tokenForDisplay}'`,
            '',
            'Wallpapers (same box, same token; wallpaper.txt is NEWEST LAST):',
            `  curl -sS -X POST '${baseUrl}/wallpaper' \\`,
            `    -H 'Authorization: Bearer ${tokenForDisplay}' \\`,
            "    -H 'Content-Type: application/octet-stream' \\",
            "    -H 'X-Wallpaper-Id: smoke-wp-1' -H 'X-Wallpaper-Target: primary' \\",
            '    --data-binary @/tmp/sleep.bmp',
            `  curl -sS -X POST '${baseUrl}/wallpaper' \\`,
            `    -H 'Authorization: Bearer ${tokenForDisplay}' \\`,
            "    -H 'Content-Type: application/octet-stream' \\",
            "    -H 'X-Wallpaper-Id: smoke-wp-2' -H 'X-Wallpaper-Target: set' \\",
            "    -H 'X-Filename: Smoke Test.bmp' --data-binary @/tmp/sleep.bmp",
            `  curl -sS '${baseUrl}/wallpaper.txt'`,
            `  curl -sS -r 1024- '${baseUrl}/wallpaper/smoke-wp-1' -o /tmp/tail.bin -D -`,
            `  curl -sS -X DELETE '${baseUrl}/wallpaper/smoke-wp-1' -H 'Authorization: Bearer ${tokenForDisplay}'`,
            '',
        ].join('\n')
    );

    const shutdown = (why) => {
        process.stdout.write(`\nmailbox-dev: ${why}, shutting down\n`);
        server.close(() => process.exit(0));
        // closeAllConnections is what actually ends keep-alive sockets; without
        // it server.close() waits for idle clients and the shutdown is advisory.
        server.closeAllConnections?.();
    };

    // Intentionally NOT unref'd: the timer must keep the loop alive on its own
    // terms so the shutdown always runs, rather than depending on the server
    // handle still being open.
    const ttlTimer = opts.ttl > 0 ? setTimeout(() => shutdown(`--ttl ${opts.ttl}s reached`), opts.ttl * 1000) : null;

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            if (ttlTimer) clearTimeout(ttlTimer);
            shutdown(signal);
        });
    }
}

// Only start a server when this file is RUN, never when it is imported.
// `scripts/mailbox-dev-server.test.js` drives readBoundedBody/rejectTooLarge
// with fake req/res objects; without this guard importing it would listen on
// 8790 for half an hour, which is exactly the class of stray process this
// repo's resource rules exist to prevent.
const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;

if (invokedDirectly) {
    main().catch((err) => {
        process.stderr.write(`mailbox-dev: ${err?.stack ?? err}\n`);
        process.exit(1);
    });
}
