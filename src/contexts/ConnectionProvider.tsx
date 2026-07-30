/**
 * ConnectionProvider — shared context for device connection and settings.
 *
 * Provides: settings, connectionStatus, saveSettings, checkConnection.
 * Connection is re-checked on mount, app foreground, and after settings change.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { AppState as RNAppState } from 'react-native';
import type { Settings, ConnectionStatus } from '../types';
import { DEFAULTS, getSettings, saveSettings as persistSettings, getCurrentIp } from '../services/settings';
import { checkCrossPointConnection } from '../services/crosspoint_upload';
import { getRole } from '../services/role';
import { ensureNearbyWifiPermission } from '../services/android_permissions';

interface ConnectionContextValue {
    settings: Settings;
    connectionStatus: ConnectionStatus;
    /**
     * False until the first getSettings() resolves. `settings` is seeded from
     * DEFAULTS (role: 'host'), so any host-only UI gated purely on
     * `isHost(settings)` renders for a client during that window. Gate on this
     * as well, so a client never sees host-only surfaces even for one frame.
     */
    settingsLoaded: boolean;
    saveSettings: (newSettings: Settings) => Promise<void>;
    checkConnection: () => Promise<void>;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function useConnection() {
    const ctx = useContext(ConnectionContext);
    if (!ctx) throw new Error('useConnection must be used within ConnectionProvider');
    return ctx;
}

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
    // Seeded from the SAME object services/settings.ts persists, so the render
    // pass before getSettings() resolves cannot disagree with it. Previously a
    // hand-copied literal lived here; a field added there but not here made the
    // first render see `role === undefined` and briefly show host-only tabs to a
    // client.
    const [settings, setSettings] = useState<Settings>(DEFAULTS);
    const [settingsLoaded, setSettingsLoaded] = useState(false);

    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
        connected: false,
        ip: getCurrentIp(DEFAULTS),
        role: DEFAULTS.role,
        checking: true,
    });

    // Use ref to avoid stale closures in the AppState listener
    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    const checkRequestRef = useRef(0);

    const checkConnection = useCallback(async () => {
        const requestId = ++checkRequestRef.current;
        setConnectionStatus(prev => ({ ...prev, checking: true, lastError: undefined }));

        // NOTHING is read out of settingsRef before this await, on purpose.
        // ensureNearbyWifiPermission can raise an OS dialog that outlives the
        // initial getSettings() load, and every setConnectionStatus below is a
        // FULL REPLACE rather than a merge — a snapshot taken up here would
        // overwrite the loaded ip/role with DEFAULTS after the load had already
        // written the correct ones.
        const permission = await ensureNearbyWifiPermission();

        if (requestId !== checkRequestRef.current) return;

        // One snapshot, taken after the await, used for both the probe target and
        // the reported status — so what we report is always what we probed.
        // A settings change mid-probe is covered by handleSaveSettings, which
        // schedules its own checkConnection; that bumps checkRequestRef and makes
        // this call early-return at the guard below instead of reporting stale.
        const s = settingsRef.current;
        const ip = getCurrentIp(s);
        const role = getRole(s);

        if (!permission.granted) {
            setConnectionStatus({
                connected: false,
                ip,
                role,
                checking: false,
                // STAMPED HERE TOO. Without the permission there is no LAN path at
                // all, which is a perfectly good — and current — reachability
                // answer for a send's fast skip to use. Leaving it unstamped would
                // make the one case we are certain about look like "never checked".
                checkedAt: Date.now(),
                lastError: permission.reason || 'Nearby devices permission is required for local Wi-Fi connection.',
            });
            return;
        }

        // Single firmware: the stock-firmware probe went with x4_upload.ts.
        // The M3 AP→LAN fallback probe belongs here — and must stay BELOW the
        // permission gate above, which early-returns without probing.
        const result = await checkCrossPointConnection(ip);

        if (requestId !== checkRequestRef.current) return;
        setConnectionStatus({
            connected: result.success,
            ip,
            role,
            checking: false,
            // AFTER the probe resolved, not before it started: this timestamp is
            // what a send's fast skip ages the answer by, and stamping it at
            // request time would make a 5 s timeout look 5 s fresher than it is.
            checkedAt: Date.now(),
            lastError: result.success ? undefined : (result.error || 'Unknown error'),
        });
    }, []);

    const handleSaveSettings = useCallback(async (newSettings: Settings) => {
        const sanitized = await persistSettings(newSettings);
        setSettings(sanitized);
        setConnectionStatus(prev => {
            const nextIp = getCurrentIp(sanitized);
            return {
                ...prev,
                ip: nextIp,
                role: getRole(sanitized),
                // A RETARGETED PROBE IS NOT A FRESH ONE. `connected` still
                // describes the OLD host until the re-check below lands, and a
                // send's fast skip would otherwise treat that answer as current
                // evidence about a reader it has never contacted. Dropping the
                // stamp downgrades it to "unknown", which is the one state that
                // cannot change a route.
                checkedAt: nextIp === prev.ip ? prev.checkedAt : undefined,
            };
        });
        // Re-check connection after short delay
        setTimeout(checkConnection, 100);
    }, [checkConnection]);

    // Load settings on mount, THEN run the first probe.
    //
    // These used to be two parallel effects firing in the same commit, which lost
    // the race every time: checkConnection awaits a permission check and a 5 s
    // HTTP probe, so it always resolved last and full-replaced the just-loaded
    // ip/role with the DEFAULTS it had captured before getSettings() returned.
    // A 'client' install rendered "Role: Host", and a custom crossPointIp was
    // probed at the default host — both persisting until the next foreground or
    // Settings save. Sequencing the probe after the load removes the race at the
    // source; checkRequestRef could not, since both calls were request #1.
    useEffect(() => {
        (async () => {
            try {
                const loaded = await getSettings();
                // Keep the ref in lockstep with the state write: checkConnection
                // reads settingsRef, and React has not re-rendered yet at this point.
                settingsRef.current = loaded;
                setSettings(loaded);
                setConnectionStatus(prev => ({
                    ...prev,
                    ip: getCurrentIp(loaded),
                    role: getRole(loaded),
                }));
            } catch (error) {
                // getSettings swallows its own errors and returns DEFAULTS today,
                // so this is unreachable — but the flag and the first probe are
                // both downstream of it, and stranding either one is worse than
                // running with DEFAULTS (which is also what role.ts falls back to
                // for an unreadable role).
                console.warn('Failed to load settings into ConnectionProvider:', error);
            } finally {
                setSettingsLoaded(true);
                void checkConnection();
            }
        })();
    }, [checkConnection]);

    // Re-check on foreground. The FIRST probe is owned by the load effect above —
    // do not add one here, it would race the load again.
    useEffect(() => {
        const sub = RNAppState.addEventListener('change', (nextState) => {
            if (nextState === 'active') {
                checkConnection();
            }
        });

        return () => sub.remove();
    }, [checkConnection]);

    return (
        <ConnectionContext.Provider
            value={{
                settings,
                connectionStatus,
                settingsLoaded,
                saveSettings: handleSaveSettings,
                checkConnection,
            }}
        >
            {children}
        </ConnectionContext.Provider>
    );
}
