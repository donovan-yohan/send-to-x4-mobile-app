#!/usr/bin/env bash
# Bounded "local CI" on server-mac. Rsyncs the working tree, selects the node
# version `.nvmrc` declares, installs deps once per (lockfile, node) change, then
# runs typecheck + the full test suite serially with a heap cap. The entire
# remote run is wall-clock-bounded from this side, so a runaway worker can never
# pin the devbox (or the mac) for hours.
#
# The runtime is PINNED, not inherited: the remote body refuses to run (exit 96)
# when the host's node major is not the one `.nvmrc`/`engines` declare. A green
# run on some other major is not evidence about the runtime the app ships on.
#
# ---------------------------------------------------------------------------
# EXIT-CODE TRANSPORT — do not "simplify" this back to plain `set -e` + ssh.
#
# server-mac is reached over Tailscale SSH (`ssh -v` reports
# "remote software version Tailscale"), and its SSH server sends
# `exit-status 0` to the client no matter what the remote command returned.
# Verified: `ssh server-mac 'exit 7'` leaves $? == 0 locally, and `ssh -v` shows
#   client_input_channel_req: channel 0 rtype exit-status reply 0
#   Exit status 0
# That is why this gate used to print "ci-remote: PASS" while tests were red:
# `set -e` never saw a failure because ssh always reported success.
#
# So the remote status is carried IN-BAND: the remote shell installs an EXIT
# trap that prints a nonce-tagged status line as its last output, and this
# script parses that line. A missing status line is treated as a failure, which
# covers timeout, SIGKILL, dropped connections and truncated output.
# ---------------------------------------------------------------------------
set -euo pipefail

HOST="${CI_HOST:-server-mac}"
DEST="${CI_DEST:-xteink-ci/send-to-x4-mobile-app}"
WALL_CLOCK="${CI_TIMEOUT:-1200}" # seconds for the whole remote run
HEAP_MB="${CI_HEAP_MB:-3072}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Per-run nonce so nothing echoed by the test output can spoof the status line.
STATUS_PREFIX="__CI_REMOTE_STATUS_${$}_${RANDOM}${RANDOM}__:"

LOG="$(mktemp "${TMPDIR:-/tmp}/ci-remote.XXXXXX")"
trap 'rm -f "$LOG"' EXIT

echo "ci-remote: rsync -> ${HOST}:${DEST}"
# This ssh's exit status is meaningless (see header). A failed mkdir surfaces as
# a real rsync failure on the next command, which set -e *does* catch.
ssh "$HOST" "mkdir -p '$DEST'" || true
# THE LEADING SLASHES ON android/ AND ios/ ARE LOAD-BEARING. An unanchored rsync
# pattern matches at ANY depth, so `--exclude android/` also dropped
# `modules/reader-link/android/**` — every Kotlin file, the module manifest and its
# build.gradle — from the tree the gate sees. That is invisible by construction:
# the current gate is tsc + node tests, so nothing failed, and any Kotlin-facing
# check added later (ktlint, a syntax pass, or the grep-based contract test that
# now reads ProxyContract.kt and Options.kt) would have passed by seeing ZERO
# files. Anchored to the transfer root, the app's prebuild output is still skipped
# and `modules/*/android/` is synced.
rsync -a --delete \
  --exclude node_modules/ \
  --exclude /android/ \
  --exclude /ios/ \
  --exclude .git/ \
  --exclude .expo/ \
  --exclude test-frames/ \
  --exclude .ci-lock-hash \
  "$REPO_ROOT/" "$HOST:$DEST/"

echo "ci-remote: install + typecheck + tests (timeout ${WALL_CLOCK}s, heap ${HEAP_MB}MB, serial)"

# Values are injected as a preamble; the body is a quoted heredoc so nothing in
# it is expanded locally.
REMOTE_SCRIPT="CI_DEST='${DEST}'
CI_HEAP_MB='${HEAP_MB}'
CI_STATUS_PREFIX='${STATUS_PREFIX}'
$(
  cat <<'REMOTE_EOF'
set -euo pipefail
# Last line of remote output carries the real exit status back to the client.
trap 'printf "%s%s\n" "$CI_STATUS_PREFIX" "$?"' EXIT
cd "$CI_DEST"

# ---------------------------------------------------------------------------
# RUNTIME: the version the repo DECLARES, not whatever is first on PATH.
#
# This host's default node is whatever brew last installed; the APK is built on
# the `.nvmrc` version. A gate that runs on a different major is evidence about
# a runtime the app does not ship on — and `npm ci` under a different npm major
# can resolve a different tree from the same lockfile. So select it explicitly
# and REFUSE to run on a mismatch: a silent fallback is exactly the failure this
# is here to remove. `.nvmrc` is read from the rsynced tree, so it and
# package.json's `engines` stay the single source of truth.
# ---------------------------------------------------------------------------
# `tr -dc` (keep only digits/dots) rather than deleting whitespace escapes: BSD
# and GNU tr disagree about backslash sequences, and this needs no escapes.
CI_NODE_WANT="$(head -n 1 .nvmrc | tr -dc '0-9.')"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # nvm's own scripts are not written for `set -u`, and `nvm use` exits nonzero
  # when the version is absent — neither is fatal here, because the version
  # check below is what actually decides.
  set +eu
  . "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1
  nvm use "$CI_NODE_WANT" >/dev/null 2>&1
  set -eu
fi
CI_NODE_HAVE="$(node -v)"
case "$CI_NODE_HAVE" in
  v"$CI_NODE_WANT".*) ;;
  *)
    echo "ci-remote: FAIL (node $CI_NODE_HAVE on the CI host, but .nvmrc/package.json engines declare ${CI_NODE_WANT}.x)" >&2
    echo "ci-remote: a green run on the wrong major is not evidence about the runtime the app ships on." >&2
    echo "ci-remote: install it once on this host with: nvm install $CI_NODE_WANT" >&2
    exit 96
    ;;
esac
echo "ci-remote: node $CI_NODE_HAVE / npm $(npm -v) (pinned by .nvmrc = $CI_NODE_WANT)"

# The node version is part of the install key: node_modules resolved by one npm
# major must not be silently reused under another.
LOCK_HASH="$(shasum -a 256 package-lock.json | cut -d' ' -f1)-$CI_NODE_HAVE"
if [ ! -d node_modules ] || [ "$(cat .ci-lock-hash 2>/dev/null)" != "$LOCK_HASH" ]; then
  echo 'ci-remote: npm ci (lockfile or node version changed)'
  npm ci --no-audit --no-fund
  printf '%s\n' "$LOCK_HASH" > .ci-lock-hash
else
  echo 'ci-remote: node_modules up to date, skipping npm ci'
fi
export NODE_OPTIONS="--max-old-space-size=${CI_HEAP_MB}"
npx tsc --noEmit
ALLOW_LOCAL_TESTS=1 node scripts/run-tests.mjs
REMOTE_EOF
)"

transport_rc=0
timeout --kill-after=30 "$WALL_CLOCK" ssh "$HOST" "$REMOTE_SCRIPT" 2>&1 | tee "$LOG" || transport_rc=$?

if [ "$transport_rc" -ne 0 ]; then
  echo "ci-remote: FAIL (ssh/timeout transport exit ${transport_rc}, wall clock ${WALL_CLOCK}s)" >&2
  exit "$transport_rc"
fi

# `|| true` is LOAD-BEARING, not defensive noise. Under this file's own
# `set -euo pipefail` the assignment takes its status from the command
# substitution, and a grep that matches NOTHING exits 1 (pipefail propagates it
# past tail/cut) — so without the `|| true` the script aborts right here and the
# `case` below never runs. That is the one scenario the in-band status line was
# built for (dropped Tailscale connection, SIGKILL, truncated output), and it
# would report a bare exit 1 immediately after the test output, which reads as
# "the tests failed" rather than "the remote run died".
remote_rc="$(grep -a "^${STATUS_PREFIX}" "$LOG" | tail -n 1 | cut -d: -f2 || true)"

case "$remote_rc" in
  '' | *[!0-9]*)
    echo "ci-remote: FAIL (remote status line missing — remote run died or output was truncated)" >&2
    exit 97
    ;;
esac

if [ "$remote_rc" -ne 0 ]; then
  echo "ci-remote: FAIL (remote run exited ${remote_rc})" >&2
  exit "$remote_rc"
fi

echo "ci-remote: PASS"
