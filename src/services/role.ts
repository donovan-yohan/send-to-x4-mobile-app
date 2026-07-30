/**
 * role.ts — single typed accessor for the host/client role.
 *
 * `Settings.role` is now the source of truth (it lands in DEFAULTS in
 * settings.ts and is seeded into ConnectionProvider from that same object).
 * This module stays as the ONE place that narrows it, because settings are an
 * unversioned AsyncStorage blob: a pre-role install, a hand-edited blob or a
 * future value all arrive here as `unknown` and must degrade to a safe default
 * rather than flashing host-only UI at a client.
 *
 * Default is 'host' — the single-device setup this fork ships with today.
 */

import type { Role, Settings } from '../types';

export type { Role };

export const DEFAULT_ROLE: Role = 'host';

/** Narrow an unknown value to a Role, falling back to DEFAULT_ROLE. */
export function asRole(value: unknown): Role {
    return value === 'host' || value === 'client' ? value : DEFAULT_ROLE;
}

/**
 * Read the role out of settings. Tolerates settings blobs written before the
 * field existed, and blobs holding a value outside the union.
 */
export function getRole(settings: Settings | null | undefined): Role {
    if (!settings) return DEFAULT_ROLE;
    return asRole(settings.role);
}

/** Convenience predicate for host-only UI gates. */
export function isHost(settings: Settings | null | undefined): boolean {
    return getRole(settings) === 'host';
}
