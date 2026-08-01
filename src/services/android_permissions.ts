import { PermissionsAndroid, Platform } from 'react-native';

const NEARBY_WIFI_PERMISSION =
    PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES || 'android.permission.NEARBY_WIFI_DEVICES';

/**
 * Android 13+ may require Nearby Wi-Fi permission for reliable local network access.
 */
export async function ensureNearbyWifiPermission(): Promise<{ granted: boolean; reason?: string }> {
    if (Platform.OS !== 'android') return { granted: true };
    if (typeof Platform.Version === 'number' && Platform.Version < 33) return { granted: true };

    try {
        const alreadyGranted = await PermissionsAndroid.check(NEARBY_WIFI_PERMISSION);
        if (alreadyGranted) return { granted: true };

        const result = await PermissionsAndroid.request(NEARBY_WIFI_PERMISSION, {
            title: 'Nearby devices permission',
            message: 'Allow nearby devices so the app can connect to your X4 over local Wi-Fi.',
            buttonPositive: 'Allow',
            buttonNegative: 'Deny',
        });

        if (result === PermissionsAndroid.RESULTS.GRANTED) {
            return { granted: true };
        }

        if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
            return { granted: false, reason: 'Nearby devices permission is disabled (Never ask again).' };
        }

        return { granted: false, reason: 'Nearby devices permission denied.' };
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { granted: false, reason: `Permission check failed: ${msg}` };
    }
}

// ---------------------------------------------------------------------------
// Fine location — asked for ONE button, and nothing else
// ---------------------------------------------------------------------------

const FINE_LOCATION_PERMISSION =
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION || 'android.permission.ACCESS_FINE_LOCATION';

/**
 * What the caller needs to know, which is more than a boolean.
 *
 * `blocked` is the case a boolean cannot express: the user picked "Don't allow"
 * twice (or "Never ask again"), and every future request resolves instantly with
 * no dialog shown. A UI that treats that as an ordinary denial offers a button
 * that visibly does nothing, which is worse than not offering it.
 *
 * `unsupported` means this is not Android — there is nothing to request and
 * nothing to explain.
 */
export type FineLocationState = 'granted' | 'denied' | 'blocked' | 'unasked' | 'unsupported';

export interface FineLocationResult {
    granted: boolean;
    state: FineLocationState;
}

/**
 * Is location already granted? DOES NOT PROMPT.
 *
 * Used to decide what the WiFi-share sheet renders before the user has touched
 * anything. `unasked` here means "not granted"; it cannot distinguish a first
 * run from a permanent denial, because `PermissionsAndroid.check` only returns a
 * boolean. Only {@link ensureFineLocationPermission} can tell those apart, and
 * only by asking.
 */
export async function checkFineLocationPermission(): Promise<FineLocationResult> {
    if (Platform.OS !== 'android') return { granted: false, state: 'unsupported' };
    try {
        const granted = await PermissionsAndroid.check(FINE_LOCATION_PERMISSION);
        return granted ? { granted: true, state: 'granted' } : { granted: false, state: 'unasked' };
    } catch {
        return { granted: false, state: 'unasked' };
    }
}

/**
 * Request ACCESS_FINE_LOCATION.
 *
 * CALLED FROM EXACTLY ONE PLACE: the "Use current network" button inside the
 * WiFi-share sheet (`components/WifiShareCard`). Never on mount, never at app
 * launch, never from any other feature.
 *
 * That constraint is the whole design. Android will not reveal the name of the
 * network the phone is on to an app without this permission — see
 * `WIFI_SHARE_PREFILL_HELP` in `services/wifi_share` — so the app either asks
 * for it in the one second where the user has just said "fill this in for me",
 * or it does not ask at all. Asking at launch, for a field the user may never
 * open, is the version of this that deserves to be denied.
 *
 * The prompt is the SYSTEM dialog; the sentence explaining why lives in the card
 * next to the button, before this is ever called, because a system dialog with
 * no context is a dialog people deny by reflex.
 */
export async function ensureFineLocationPermission(): Promise<FineLocationResult> {
    if (Platform.OS !== 'android') return { granted: false, state: 'unsupported' };

    try {
        const alreadyGranted = await PermissionsAndroid.check(FINE_LOCATION_PERMISSION);
        if (alreadyGranted) return { granted: true, state: 'granted' };

        const result = await PermissionsAndroid.request(FINE_LOCATION_PERMISSION, {
            title: 'Show your current network?',
            message:
                'Android only tells an app which WiFi network the phone is on if the app holds ' +
                'location permission. Allowing it fills in the network name here. Nothing else ' +
                'in this app uses location, and you can always type the name yourself.',
            buttonPositive: 'Allow',
            buttonNegative: 'Not now',
        });

        if (result === PermissionsAndroid.RESULTS.GRANTED) {
            return { granted: true, state: 'granted' };
        }
        if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
            return { granted: false, state: 'blocked' };
        }
        return { granted: false, state: 'denied' };
    } catch {
        // A throw here is a broken bridge, not a decision by the user. Reported
        // as a plain denial so the caller keeps the manual field and says
        // nothing alarming about it.
        return { granted: false, state: 'denied' };
    }
}

