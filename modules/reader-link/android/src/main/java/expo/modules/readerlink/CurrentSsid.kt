package expo.modules.readerlink

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build

// CurrentSsid resolves the name of the Wi-Fi network THIS PHONE is currently on, so the
// "Share WiFi with reader" sheet can offer it instead of asking the user to retype what
// their own status bar already shows.
//
// It is the only place in this module that touches a location-grade API, and it is
// deliberately tiny: one entry point, no state, no threads, no callbacks, no listeners.
// The whole of it runs synchronously on whatever thread expo hands the AsyncFunction.
//
// WHY THIS LIVES IN reader-link AND NOT IN A NEW MODULE
// This module already owns every ConnectivityManager call the app makes (PeerApLink,
// UpstreamNetwork, ReaderLinkSession), it already declares the connectivity permissions in
// its own AndroidManifest.xml, and it is already autolinked. A second native module would
// duplicate the manifest, the gradle wiring and the JS binding to add one function.
//
// IT NEVER THROWS. Every path returns a { ssid, reason } map, including the ones that
// would ordinarily be programming errors (null context, a system service that came back
// as the wrong type, a SecurityException from an OEM that guards something extra). A
// prefill that fails must degrade to "type it yourself", never to a rejected promise the
// card has to catch, and never to a crash on a screen the user only opened to type a
// password.
//
// REASON CODES, and the UI meaning of each. These four are the whole vocabulary; the JS
// side (src/services/wifi_ssid.ts) maps them to what the card shows.
//   ok           ssid is non-null and is the network name.
//   permission   ACCESS_FINE_LOCATION is not granted. The card offers the request.
//   no-wifi      the phone is not on Wi-Fi at all (cellular only, airplane mode, or the
//                active network is the reader's own AP mid-sync). Asking for location
//                would not help, so the card must not offer it.
//   unavailable  everything else: the platform gave us no WifiInfo, or gave us one whose
//                SSID is still the redacted sentinel even though the permission IS held.
//                In practice that last case is location services being switched off
//                device-wide, which no runtime prompt can fix.
//
// ANDROID API PROVENANCE (checked against the platform docs for the APIs used; the Kotlin
// in this repo is not compile-verified in this workflow):
//   ConnectivityManager.getActiveNetwork()          API 23, android.net.ConnectivityManager
//   ConnectivityManager.getNetworkCapabilities(n)   API 21, same class
//   NetworkCapabilities.hasTransport(TRANSPORT_WIFI) API 21, android.net.NetworkCapabilities
//   NetworkCapabilities.getTransportInfo()          API 29. Documented to carry the
//                                                   WifiInfo for a Wi-Fi network, and
//                                                   documented to redact SSID and BSSID
//                                                   from callers that do not hold location
//                                                   permission. This is the PREFERRED read
//                                                   on API 29+.
//   WifiManager.getConnectionInfo()                 deprecated at API 31 in favour of the
//                                                   transportInfo route above; kept as the
//                                                   fallback for API 24 to 28, where
//                                                   getTransportInfo does not exist.
//   WifiInfo.getSSID()                              documented: "If the SSID can be decoded
//                                                   as UTF-8, it will be returned surrounded
//                                                   by double quotation marks. Otherwise, it
//                                                   is returned as a string of hex digits.
//                                                   The SSID may be UNKNOWN_SSID if there is
//                                                   no network currently connected, or if
//                                                   the caller has insufficient permissions."
//                                                   WifiManager.UNKNOWN_SSID is the literal
//                                                   "<unknown ssid>" (spelled out below
//                                                   rather than referenced, because the
//                                                   constant itself is only public from
//                                                   API 30).
//   Context.checkSelfPermission(String)             API 23, android.content.Context
//   Module minSdk is 24 (expo-module-gradle-plugin default, ProjectConfiguration.kt), so
//   every API above except getTransportInfo needs no version gate.
internal object CurrentSsid {

  const val REASON_OK = "ok"
  const val REASON_PERMISSION = "permission"
  const val REASON_UNAVAILABLE = "unavailable"
  const val REASON_NO_WIFI = "no-wifi"

  // WifiManager.UNKNOWN_SSID, inlined. Comparison is case insensitive because the sentinel
  // is a platform string the app must recognise, not a value it produces.
  private const val UNKNOWN_SSID = "<unknown ssid>"

  // The one entry point. Returns { ssid: String?, reason: String }.
  fun read(context: Context?): Map<String, Any?> =
    try {
      resolve(context)
    } catch (e: Throwable) {
      // Includes SecurityException, which some OEM builds throw instead of redacting, and
      // any ClassCastException from a system service that is not what its name says.
      result(null, REASON_UNAVAILABLE)
    }

  private fun resolve(context: Context?): Map<String, Any?> {
    val app = context?.applicationContext ?: return result(null, REASON_UNAVAILABLE)

    val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
      ?: return result(null, REASON_UNAVAILABLE)

    // The ACTIVE network, not a requested one. This function is a read of "what is the
    // phone on right now", so it must never register a NetworkRequest: that would bring a
    // radio up, and it would sit in the callback machinery this module keeps for the peer
    // link. A null active network means no default route at all.
    val active = cm.activeNetwork ?: return result(null, REASON_NO_WIFI)
    val caps = cm.getNetworkCapabilities(active) ?: return result(null, REASON_NO_WIFI)
    if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
      return result(null, REASON_NO_WIFI)
    }

    val granted = hasFineLocation(app)

    val info = wifiInfo(app, caps)
      ?: return result(null, if (granted) REASON_UNAVAILABLE else REASON_PERMISSION)

    val ssid = normalize(info.ssid)
    return when {
      ssid != null -> result(ssid, REASON_OK)
      // Permission held and the name is STILL redacted: location services are off
      // device-wide, or the association is half up. Neither is a permission problem, so
      // the card must not offer a prompt that cannot change the answer.
      granted -> result(null, REASON_UNAVAILABLE)
      else -> result(null, REASON_PERMISSION)
    }
  }

  private fun hasFineLocation(app: Context): Boolean =
    app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED

  // API 29+ reads the WifiInfo off the capabilities of the network we already resolved,
  // which is the route the platform documents and the only one that stays correct under
  // STA+STA concurrency: WifiManager.getConnectionInfo has no way to say WHICH association
  // it is describing when the phone holds two.
  private fun wifiInfo(app: Context, caps: NetworkCapabilities): WifiInfo? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val transportInfo = caps.transportInfo
      if (transportInfo is WifiInfo) return transportInfo
    }
    @Suppress("DEPRECATION")
    val manager = app.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return null
    @Suppress("DEPRECATION")
    return manager.connectionInfo
  }

  // Turn whatever WifiInfo.getSSID() returned into either a displayable network name or
  // null. MIRRORED IN JS by normalizeSsid() in src/services/wifi_ssid.ts, which is where
  // the cases are actually tested (scripts/wifi-ssid.test.js): Kotlin cannot be compiled
  // in this workflow, so the executable statement of these rules has to live on the JS
  // side, and the JS side re-normalises what this returns anyway.
  //
  // THE QUOTES ARE THE SIGNAL, not noise to strip and forget. A quoted value is one the
  // platform could decode as UTF-8, i.e. a real name; an unquoted one is either the
  // redaction sentinel or a hex dump of bytes that are not text. So the sentinel checks
  // apply ONLY to unquoted values, which is what keeps a network genuinely named "0xCoffee"
  // from being thrown away.
  //
  // Nothing inside the quotes is trimmed: an SSID may legitimately begin or end with a
  // space, and this value is about to be handed to a reader that has to match it byte for
  // byte. Only a value that is entirely blank is rejected.
  internal fun normalize(raw: String?): String? {
    if (raw == null) return null
    val outer = raw.trim()
    if (outer.isEmpty()) return null

    val quoted = outer.length >= 2 && outer.first() == '"' && outer.last() == '"'
    if (quoted) {
      val inner = outer.substring(1, outer.length - 1)
      return if (inner.isBlank()) null else inner
    }

    if (outer.equals(UNKNOWN_SSID, ignoreCase = true)) return null
    if (outer.length >= 2 && outer.regionMatches(0, "0x", 0, 2, ignoreCase = true)) return null
    return outer
  }

  private fun result(ssid: String?, reason: String): Map<String, Any?> =
    mapOf("ssid" to ssid, "reason" to reason)
}
