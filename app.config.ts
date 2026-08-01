import "dotenv/config";
import type { ExpoConfig, ConfigContext } from "expo/config";
import appJson from "./app.json";

export default ({ config }: ConfigContext): ExpoConfig => {
    const bundleId = process.env.APP_BUNDLE_ID;
    const appGroup = process.env.APP_IOS_APP_GROUP;
    const easProjectId = process.env.EAS_PROJECT_ID;

    if (!bundleId || !appGroup || !easProjectId) {
        console.warn(
            "⚠️  Missing .env values. Copy .env.example to .env and fill in your values."
        );
    }

    return {
        ...config,
        name: appJson.expo.name,
        slug: appJson.expo.slug,
        version: appJson.expo.version,
        jsEngine: "hermes",
        orientation: "portrait",
        icon: "./assets/icon.png",
        // Warm cream paper — lightColors.bg in src/theme/tokens.ts. These three
        // backgroundColor values (here, splash, android.adaptiveIcon) are what
        // the OS paints BEFORE any JS runs, so they must move together: leave one
        // on the old navy and the app flashes #1a1a2e on every cold start no
        // matter how thoroughly the screens are retokenized.
        backgroundColor: "#F6EEDF",
        userInterfaceStyle: "automatic",
        newArchEnabled: true,
        splash: {
            image: "./assets/splash-icon.png",
            resizeMode: "contain",
            backgroundColor: "#F6EEDF",
            // Cozy dark: without a dark variant the pre-JS window/splash stays
            // cream in dark mode (values-night is empty in prebuild output) and
            // translucent surfaces composite against it.
            dark: {
                image: "./assets/splash-icon.png",
                resizeMode: "contain",
                backgroundColor: "#231714",
            },
        },
        ios: {
            supportsTablet: true,
            bundleIdentifier: bundleId || "com.example.sendtox4",
            buildNumber: appJson.expo.ios.buildNumber,
            infoPlist: {
                NSAppTransportSecurity: {
                    NSAllowsLocalNetworking: true,
                },
            },
        },
        android: {
            versionCode: appJson.expo.android.versionCode,
            adaptiveIcon: {
                // The foreground PNG is transparent outside the note+heart, so
                // this flat color IS the icon's background layer.
                foregroundImage: "./assets/adaptive-icon.png",
                backgroundColor: "#F6EEDF",
            },
            package: bundleId || "com.example.sendtox4",
            edgeToEdgeEnabled: true,
            predictiveBackGestureEnabled: false,
            usesCleartextTraffic: true,
            // TWO PERMISSIONS THIS LIST DOES NOT CONTAIN, ON PURPOSE.
            //
            // CHANGE_NETWORK_STATE and ACCESS_FINE_LOCATION are declared in
            // modules/reader-link/android/src/main/AndroidManifest.xml instead,
            // where the manifest merger picks them up on every build. Anything
            // that only exists in `android/` is prebuild output and can be lost
            // by a regeneration; a library manifest cannot. That file carries
            // the full rationale for both.
            //
            // NEARBY_WIFI_DEVICES IS DECLARED BARE, with no
            // `usesPermissionFlags="neverForLocation"` — expo emits a plain
            // <uses-permission> from this array and nothing in the repo adds
            // the flag. Do not add it. It is a promise that the app derives no
            // location from Wi-Fi, and the platform keeps that promise by
            // redacting exactly the field the "Share WiFi with reader" prefill
            // reads (WifiInfo.getSSID). src/services/wifi_share.ts used to
            // state that this app declared the flag; it never did, and that
            // sentence has been corrected rather than the manifest changed.
            permissions: [
                "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.ACCESS_WIFI_STATE",
                "android.permission.NEARBY_WIFI_DEVICES",
                "android.permission.INTERNET",
                "android.permission.READ_EXTERNAL_STORAGE",
                "android.permission.WRITE_EXTERNAL_STORAGE",
            ],
        } as ExpoConfig["android"],
        web: {
            favicon: "./assets/favicon.png",
        },
        scheme: "sendtox4",
        plugins: [
            [
                "expo-build-properties",
                {
                    android: {
                        compileSdkVersion: 36,
                        targetSdkVersion: 36,
                    },
                },
            ],
            [
                "expo-share-intent",
                {
                    iosActivationRules: {
                        NSExtensionActivationSupportsText: true,
                        NSExtensionActivationSupportsWebURLWithMaxCount: 1,
                        NSExtensionActivationSupportsWebPageWithMaxCount: 1,
                        NSExtensionActivationSupportsImageWithMaxCount: 1,
                    },
                    iosAppGroupIdentifier: appGroup || "group.com.example.sendtox4",
                    androidIntentFilters: ["text/*", "image/*"],
                },
            ],
            [
                "expo-image-picker",
                {
                    photosPermission:
                        "Select BMP screensavers to send to your X4.",
                },
            ],
            "./plugins/with-local-network-security",
        ],
        extra: {
            eas: {
                projectId: easProjectId || "",
            },
        },
    };
};
