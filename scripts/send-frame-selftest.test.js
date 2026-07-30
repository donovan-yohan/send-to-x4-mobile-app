/**
 * send_frame.mjs --self-test — the OPT-IN gate for the CLI's own protocol test.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * `scripts/send_frame.mjs --self-test` is the ONLY coverage of the CLI-side
 * delete-then-frame-then-sidecar ordering and of the exact bytes each step puts
 * on the wire (~144 checks: T1 happy path, T5 id validation, T6 path helpers,
 * T7/T7b/T7c the firmware's overwrite refusal). Every one of those is a
 * regression the app-side tests CANNOT catch, because the CLI reimplements the
 * protocol rather than importing the app's sender.
 *
 * `npm run ci` is `tsc --noEmit` + `scripts/*.test.js`. Nothing in that gate ran
 * the self-test, so all of that coverage was documentation: a future edit could
 * break the ordering and every required check would still be green. That is the
 * definition of NOT BACKPRESSURE — a test that cannot fail the build is a
 * comment.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS OPT-IN RATHER THAN ALWAYS-ON
 * ---------------------------------------------------------------------------
 * The self-test is genuinely more fragile than everything else in `scripts/`: it
 * binds EPHEMERAL HTTP and WS sockets on 127.0.0.1, T2 polls a ~900 ms window and
 * T3b enforces a 300 ms handshake deadline. Those are real timing assumptions on
 * a shared CI host, and a flake here would redden a gate whose whole value is
 * that a red run means something. A gate people learn to re-run is worth less
 * than a gap people can see.
 *
 * So: the harness is COMMITTED and the wiring is proven, and arming it is one
 * environment variable —
 *
 *     RUN_SEND_FRAME_SELFTEST=1 npm run ci
 *
 * That makes the gap a CHOICE with a switch next to it rather than a surprise.
 * Run it whenever `send_frame.mjs`, the WS upload protocol, or the sidecar
 * ordering changes; the recorded trade-off is in HANDOFF.md.
 *
 * This file asserts the CONTRACT, not the contents: exit 0 and the terminal
 * 'SELF-TEST OK' line. `send_frame.mjs` already prints which check failed and
 * exits nonzero, and duplicating its 144 assertions here would be a second
 * source of truth to keep in sync.
 *
 * Run:  RUN_SEND_FRAME_SELFTEST=1 node --import tsx --test scripts/send-frame-selftest.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Set to '1' to actually run the self-test. See the header. */
const ENV_FLAG = 'RUN_SEND_FRAME_SELFTEST';

/**
 * Wall clock for the child. The self-test finishes in a couple of seconds; this
 * is deliberately far above that so a slow CI host is never the reason it fails,
 * while still bounding a mock server that wedged.
 */
const CHILD_TIMEOUT_MS = 120_000;

/** Never accumulate an unbounded child's output in memory. */
const MAX_CAPTURED_CHARS = 200_000;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'send_frame.mjs');

/** Last N characters of the child's output — the failure detail is at the end. */
function tail(text, chars = 4000) {
    return text.length <= chars ? text : `...\n${text.slice(-chars)}`;
}

/**
 * Run `node scripts/send_frame.mjs --self-test` and report how it ended.
 *
 * DETACHED so the child gets its own process group: the self-test starts mock
 * HTTP/WS servers, and killing only the parent pid on timeout would leave those
 * listening. Never rejects — a spawn failure is a result, so the assertion below
 * is what reports it.
 */
function runSelfTest() {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [SCRIPT, '--self-test'], {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });

        let output = '';
        let timedOut = false;
        const capture = chunk => {
            if (output.length < MAX_CAPTURED_CHARS) output += String(chunk);
        };
        child.stdout.on('data', capture);
        child.stderr.on('data', capture);

        const timer = setTimeout(() => {
            timedOut = true;
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                // Already gone.
            }
        }, CHILD_TIMEOUT_MS);

        child.on('error', error => {
            clearTimeout(timer);
            resolve({ code: null, signal: null, timedOut, output: `${output}\nspawn failed: ${error.message}` });
        });
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, timedOut, output });
        });
    });
}

test(
    'send_frame.mjs --self-test passes (the CLI sidecar ordering has no other gate)',
    {
        skip: process.env[ENV_FLAG] === '1'
            ? false
            : `opt-in: set ${ENV_FLAG}=1 to run it (binds ephemeral sockets and asserts sub-second timings; see this file's header)`,
        // Above the child's own bound, so a hung child is reported as a child
        // timeout with its output rather than as an opaque runner timeout.
        timeout: CHILD_TIMEOUT_MS + 30_000,
    },
    async () => {
        const result = await runSelfTest();

        assert.equal(
            result.timedOut,
            false,
            `--self-test did not finish within ${CHILD_TIMEOUT_MS} ms:\n${tail(result.output)}`
        );
        assert.equal(
            result.code,
            0,
            `--self-test exited ${result.code}${result.signal ? ` (signal ${result.signal})` : ''}:\n${tail(result.output)}`
        );
        // Belt and braces: the CLI sets process.exitCode and then force-exits on a
        // timer, so a future refactor could plausibly exit 0 without having run
        // the checks. The terminal line only prints when every check passed.
        assert.match(result.output, /SELF-TEST OK/, `no 'SELF-TEST OK' line:\n${tail(result.output)}`);
    }
);
