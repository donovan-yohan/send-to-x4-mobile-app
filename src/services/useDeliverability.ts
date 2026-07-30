/**
 * useDeliverability — the React binding for `services/deliverability.ts`.
 *
 * Thin ON PURPOSE. Everything decidable lives in the pure module next door,
 * where a node test can drive every cell of the truth table; this file only
 * gathers the two inputs the app already holds (ConnectionProvider's settings
 * and its last reachability observation) and hands them over. If you find
 * yourself adding an `if` here, it belongs in `deriveDeliverability`.
 *
 * SEPARATE FILE, because `deliverability.ts` must stay loadable under node:
 * `useConnection` reaches react-native through the provider, and a single import
 * of it would make the model — and every test of it — impossible to load. This
 * is the same split `theme/useTheme.ts` uses over `theme/tokens.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHEN THIS RE-EVALUATES, AND WHY IT DOES NOT TICK
 * ---------------------------------------------------------------------------
 * The derivation is freshness-aware, but this hook holds NO timer: it recomputes
 * when `settings` or `connectionStatus` change — i.e. on the first probe, on
 * every app foreground, after a settings save, and on a user-driven re-check —
 * and not otherwise. That is deliberate. A chip that silently downgraded itself
 * mid-compose, while the user did nothing and the app learned nothing, would be
 * motion without information; the stale observation it is drawn from is also
 * exactly what the send would use.
 *
 * The bound is worth knowing: sit in the foreground for several minutes and
 * `directNow` still reflects the last probe. If a surface ever needs the direct
 * state to decay in place, the fix belongs in ConnectionProvider (re-probe, or
 * expire `checkedAt`) so the whole app decays together — not in a per-screen
 * interval.
 */

import { useMemo } from 'react';

import { useConnection } from '../contexts/ConnectionProvider';
import { deriveDeliverability, type Deliverability } from './deliverability';
import { getRole } from './role';
import { getCurrentIp } from './settings';

export function useDeliverability(): Deliverability {
    const { settings, connectionStatus } = useConnection();

    return useMemo(
        () =>
            deriveDeliverability({
                settings: {
                    role: getRole(settings),
                    // Normalised here, exactly as Compose builds its
                    // `LoveNoteDestination`, so the model sees the host a send
                    // would actually dial.
                    ip: getCurrentIp(settings),
                    mailboxUrl: settings.mailboxUrl,
                    mailboxWriteToken: settings.mailboxWriteToken,
                    // `readerApPsk` is NOT passed and is not an input to the
                    // model: it is what the platform join request uses once
                    // Sync-with-reader is already running, not what decides
                    // whether Sync-with-reader can run. See the header note in
                    // `deliverability.ts`.
                },
                reachability: {
                    reachable: connectionStatus.connected,
                    // `checkedAt` is absent until the first probe RESOLVES, and
                    // that absence is load-bearing: `connected` is seeded false,
                    // so without the stamp the launch window would read as a
                    // measured "the reader is asleep" instead of "not asked yet".
                    checkedAt: connectionStatus.checkedAt ?? null,
                },
            }),
        [settings, connectionStatus]
    );
}
