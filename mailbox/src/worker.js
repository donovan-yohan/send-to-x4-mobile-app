/**
 * Cloudflare Workers glue for the Xteink mailbox.
 *
 * DELIBERATELY THIN. Every routing, validation and ordering decision lives in
 * `core.js`, which is platform-free and covered by `scripts/mailbox-core.test.js`.
 * The only things that belong here are: turning a `Request` into the core's
 * plain request shape, adapting KV to the core's two-method store, and turning
 * the core's plain response back into a `Response`.
 *
 * Bindings expected (see wrangler.jsonc / README.md):
 *   MAILBOX_KV   KV namespace       — one id pointer + at most two frames per box,
 *                                     plus one book manifest and at most
 *                                     MAX_BOOKS epub blobs when books are used
 *   WRITE_TOKEN  secret (string)    — bearer token for /publish, /status, /books
 */

import { MAX_REQUEST_BODY_BYTES, handleRequest, requestBodyLimit, writeAuthPreflight } from './core.js';

/**
 * KV -> core store adapter.
 *
 * `get` normalises a miss to null and a hit to Uint8Array, which is exactly the
 * contract `createMemoryStore` implements, so the tests' store and this one are
 * interchangeable.
 *
 * NOTE ON CONSISTENCY — the reason core.js content-addresses the frame key.
 *
 * Workers KV is eventually consistent, reads are edge-cached PER KEY (60 s
 * floor) and writes replicate PER KEY. There is no cross-key ordering or
 * atomicity: a colo can hold the newest `:meta` and a 60-second-old `:frame`
 * at the same instant, and the frame-before-pointer write order constrains only
 * the origin, never a replica.
 *
 * That is fatal for a mutable frame slot, because the reader pairs the id and
 * the bytes across two separate HTTP requests and then dedups on the id: a
 * fresh id served with stale (but still exactly 52272-byte) bytes is staged,
 * rendered, marked shown, and never re-fetched. core.js therefore derives the
 * frame key FROM the id it just read (`box:{id}:frame:{noteId}`), so an
 * unreplicated frame can only 404 — a state the firmware already handles by
 * retrying at the next sleep. Do not "optimise" that back into one key.
 *
 * What remains is pure DELAY: a publish can take up to ~60 s to be visible from
 * every colo, so "publish then immediately put the reader to sleep" can miss by
 * one cycle. The reader syncs at deep-sleep ENTRY and renders at the NEXT wake,
 * so that is inside tolerance. Do not add a cacheTtl below 60 expecting to fix
 * it; KV will not honour it.
 *
 * NO `stat`/`getRange` HERE, deliberately. Those are the optional half of the
 * store contract and KV has no ranged read — a partial book fetch would still
 * pull the whole value, so implementing them would only hide that cost. The core
 * therefore takes its fetch-once-and-slice path on Workers, which is correct but
 * means one ranged request costs one full value read. That is also why
 * MAX_BOOK_BYTES is 24 MiB rather than 30 MB: it is what KV can hold at all.
 */
function kvStore(kv) {
    return {
        async get(key) {
            const buf = await kv.get(key, { type: 'arrayBuffer' });
            return buf ? new Uint8Array(buf) : null;
        },
        async put(key, value) {
            await kv.put(key, value);
        },
        // Publish's bounded GC of superseded frames. Optional on the store
        // contract, and best-effort at the call site — a failed delete leaks
        // 52 KB, it never affects what the reader sees.
        async delete(key) {
            await kv.delete(key);
        },
    };
}

/**
 * Read at most `limit` bytes off the request.
 *
 * `request.arrayBuffer()` would buffer whatever the client sends (up to the
 * platform cap, orders of magnitude past one frame) before the core ever gets a
 * chance to answer 413. Check the declared length first, then stream with a
 * running cap so a lying or absent Content-Length cannot get past it either.
 */
async function readBoundedBody(request, limit) {
    const declared = request.headers.get('content-length');
    if (declared !== null) {
        const n = Number(declared);
        if (!Number.isFinite(n) || n < 0) return { tooLarge: false, bytes: null, invalid: true };
        if (n > limit) return { tooLarge: true };
    }
    if (!request.body) return { bytes: new Uint8Array(0) };

    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            return { tooLarge: true };
        }
        chunks.push(value);
    }
    // ONE allocation, and each chunk is dropped as it is copied so the peak
    // decays toward 1x the body instead of holding 2x until this returns. On the
    // 24 MiB books route that difference is most of an isolate's headroom.
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
        out.set(chunks[i], offset);
        offset += chunks[i].byteLength;
        chunks[i] = null;
    }
    return { bytes: out };
}

function jsonResponse(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store, no-cache, must-revalidate',
        },
    });
}

/**
 * Core response -> `Response`.
 *
 * CONTENT-LENGTH, and why the `head` gate is load-bearing. When there IS a body,
 * the runtime computes the length itself and a hand-set header is pointless at
 * best and a lie at worst (measured on workerd via wrangler 4.97: a 10-byte body
 * sent with `content-length: 1874233` went out as `Content-Length: 10` — the
 * runtime always wins, so passing ours through would be dead weight).
 *
 * A HEAD is the opposite case: there is no body to measure, so if we drop the
 * header the response reports `Content-Length: 0` and a client probing a book's
 * size learns nothing. workerd DOES pass a hand-set length through on a
 * null-body Response — same measurement: `new Response(null, {'content-length':
 * '1874233'})` answered `Content-Length: 1874233`, no rejection, no override.
 * So keep it, and keep it ONLY for HEAD: any other null body carrying a length
 * would leave a client waiting for bytes that never come.
 *
 * This mirrors `send()`'s `{head}` gate in `scripts/mailbox_dev_server.mjs`,
 * which is the point — §2 of `docs/xteink/mailbox-books-contract.md` promises
 * Content-Length is correct on HEAD, and a promise that only one adapter keeps
 * is worse than no promise.
 */
function toResponse(result, { head = false } = {}) {
    const headers = { ...result.headers };
    if (result.body !== null || !head) delete headers['content-length'];
    return new Response(result.body === null ? null : result.body, {
        status: result.status,
        headers,
    });
}

export default {
    async fetch(request, env) {
        if (!env || !env.MAILBOX_KV) {
            return jsonResponse(503, { ok: false, error: 'not_configured', detail: 'MAILBOX_KV binding missing' });
        }

        let path;
        try {
            path = new URL(request.url).pathname;
        } catch {
            return jsonResponse(400, { ok: false, error: 'bad_request', detail: 'unparseable URL' });
        }

        const method = request.method.toUpperCase();
        const config = { writeToken: typeof env.WRITE_TOKEN === 'string' ? env.WRITE_TOKEN : '' };

        let body = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            // PER-ROUTE cap, decided by core.js: 64 KB for the note routes,
            // MAX_BOOK_BYTES for `POST /books`. The books cap is sized to stay
            // inside the 25 MiB KV value ceiling, so a body this accepts is a
            // body `kv.put` can store — the alternative is a 200 for a book that
            // never lands.
            const limit = requestBodyLimit(method, path);

            // AUTH BEFORE BUFFERING on any route whose cap is above the notes
            // cap. `requestBodyLimit` sees only method+path, so without this an
            // unauthenticated caller who knows the boxId — a READ capability
            // that travels in cleartext by design — could stream 24 MiB into the
            // isolate and be answered 401, at ~2x the body in peak memory
            // (`chunks` plus the concatenated copy) against a 128 MB limit.
            // Returning here never reads `request.body`, so the runtime tears the
            // upload down instead of us paying for it.
            if (limit.bytes > MAX_REQUEST_BODY_BYTES) {
                const denied = writeAuthPreflight(request.headers, config);
                if (denied) return toResponse(denied);
            }

            const read = await readBoundedBody(request, limit.bytes);
            if (read.tooLarge) {
                return jsonResponse(413, {
                    ok: false,
                    error: limit.error,
                    detail: `body exceeds ${limit.bytes} bytes`,
                });
            }
            if (read.invalid) {
                return jsonResponse(400, { ok: false, error: 'bad_request', detail: 'invalid Content-Length' });
            }
            body = read.bytes;
        }

        const result = await handleRequest(
            { method, path, headers: request.headers, body },
            kvStore(env.MAILBOX_KV),
            config
        );
        return toResponse(result, { head: method === 'HEAD' });
    },
};
