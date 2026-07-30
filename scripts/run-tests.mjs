#!/usr/bin/env node
// Bounded test runner. The full suite is NOT allowed to run on hermes-devbox:
// unbounded node --test workers have previously consumed ~20 GiB and stalled the
// host (D-state I/O, swap exhaustion). Use `npm run ci` (bounded run on
// server-mac) instead, or set ALLOW_LOCAL_TESTS=1 to override deliberately.
// When it does run, the suite is serial (--test-concurrency=1), heap-capped,
// and wall-clock-limited — do not remove these bounds.
//
// Exit contract (relied on by scripts/ci-remote.sh — do not weaken):
//   0   every test file passed
//   1   at least one test failed, or the runner was killed by a signal
//   2   refused to run on a blocked host
//   124 wall-clock limit exceeded (process group SIGKILLed)
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { hostname } from 'node:os';

const BLOCKED_HOSTS = ['hermes-devbox'];
const HEAP_MB = 3072;
const WALL_CLOCK_MS = 10 * 60 * 1000;

if (BLOCKED_HOSTS.includes(hostname()) && process.env.ALLOW_LOCAL_TESTS !== '1') {
  console.error(
    `run-tests: refusing to run the test suite on ${hostname()}.\n` +
      'This box has been stalled by runaway test workers before.\n' +
      'Use `npm run ci` (bounded run on server-mac), or ALLOW_LOCAL_TESTS=1 to override.'
  );
  process.exit(2);
}

const tests = readdirSync('scripts')
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => `scripts/${f}`)
  .sort();

if (tests.length === 0) {
  console.error('run-tests: no scripts/*.test.js found');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${HEAP_MB}`.trim(),
    },
    detached: true, // own process group so the timeout can kill test workers too
  }
);

let timer = null;
let timedOut = false;
let settled = false;

// Single place that decides the process exit status, so a late event can never
// silently downgrade an earlier failure (the timeout path used to be clobbered
// by the SIGKILL 'exit' event that it caused).
const finish = (code, reason) => {
  if (settled) return;
  settled = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  process.exitCode = code;
  if (code === 0) {
    console.log(`run-tests: PASS (${tests.length} test files, node --test exited 0)`);
  } else {
    console.error(`run-tests: FAIL (${reason}) -> exiting ${code}`);
  }
};

timer = setTimeout(() => {
  timedOut = true;
  console.error(
    `run-tests: wall-clock limit (${WALL_CLOCK_MS / 60000} min) exceeded, killing test process group`
  );
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {}
}, WALL_CLOCK_MS);

// The child is detached (own process group), so it does not receive the
// terminal's/CI's SIGINT|SIGTERM automatically. Forward it, otherwise an
// aborted run leaves orphaned test workers chewing memory.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  });
}

child.on('error', (err) => {
  finish(1, `could not spawn node --test: ${err.message}`);
});

child.on('exit', (code, signal) => {
  if (timedOut) {
    finish(124, `wall-clock timeout after ${WALL_CLOCK_MS / 60000} min`);
    return;
  }
  if (signal) {
    finish(1, `node --test killed by ${signal}`);
    return;
  }
  finish(code ?? 1, `node --test exited ${code}`);
});
