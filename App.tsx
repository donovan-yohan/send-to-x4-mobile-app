import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type Theme as NavigationTheme,
} from '@react-navigation/native';
import { BottomTabBar, createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useShareIntent } from 'expo-share-intent';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ConnectionProvider, useConnection } from './src/contexts/ConnectionProvider';
import { ProgressProvider } from './src/contexts/ProgressProvider';
import { ConnectionBanner } from './src/components/ConnectionBanner';
import { TabBarScrim } from './src/components/TabBarScrim';
import { ComposeScreen } from './src/screens/ComposeScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import { WallpaperScreen } from './src/screens/WallpaperScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { DeviceScreen } from './src/screens/DeviceScreen';
import { isHost } from './src/services/role';
import { ACTIVE_STROKE, DEFAULT_STROKE, Icon, type IconName } from './src/components/icons';
import {
  TAB_BAR_PILL_GAP,
  TAB_BAR_PILL_HEIGHT,
  useTabBarPillLayout,
  useTheme,
  type Theme,
} from './src/theme';
import type { SharedImage } from './src/types';

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

/**
 * One tab glyph.
 *
 * `color` comes from React Navigation, already resolved from
 * tabBarActiveTintColor / tabBarInactiveTintColor, so active/inactive is a HUE
 * change plus a stroke-weight change — not the old `opacity: focused ? 1 : 0.4`
 * fade. The fade is gone on purpose: `textMuted` at 40% opacity does not hold the
 * 3:1 contrast the rebrand requires of icons, and the color swap already carries
 * the state.
 */
function TabIcon({ name, focused, color }: { name: IconName; focused: boolean; color: string }) {
  return (
    <Icon
      name={name}
      size={24}
      color={color}
      strokeWidth={focused ? ACTIVE_STROKE : DEFAULT_STROKE}
    />
  );
}

interface MainTabsProps {
  sharedText: string | null;
  setSharedText: (value: string | null) => void;
  sharedImage: SharedImage | null;
  setSharedImage: (value: SharedImage | null) => void;
}

function MainTabs({ sharedText, setSharedText, sharedImage, setSharedImage }: MainTabsProps) {
  const { settings, settingsLoaded } = useConnection();
  const theme = useTheme();
  // The root SafeAreaView only consumes the TOP edge, so the navigator still
  // owns the bottom inset and the pill has to lift itself over the home
  // indicator / nav bar by hand. Same source as the screens' content padding.
  const { bottom: pillBottom } = useTabBarPillLayout();

  // Host owns permanent device state (wallpaper, file browser); a client only
  // ever composes messages. Role currently defaults to 'host' — see src/services/role.ts.
  //
  // settingsLoaded is half the gate: `settings` is seeded from DEFAULTS
  // (role: 'host'), and ConnectionProvider mounts after the 500 ms splash gate,
  // so the AsyncStorage read is NOT hidden behind the splash. Without this a
  // client renders Wallpaper + Device for every frame until getSettings()
  // resolves. Erring this way costs a host two tabs for one frame; erring the
  // other way leaks host-only surfaces to a client, which is the exact thing the
  // role model exists to prevent.
  const hostOnly = settingsLoaded && isHost(settings);

  // BottomTabView renders whatever `tabBar` returns as the LAST child of the
  // navigator, above the scene container — which makes this the only seam where
  // something can sit above the scrolling content but below the pill. Order
  // inside the fragment is the z-order on iOS; on Android the pill also carries
  // `shadows.raised`'s elevation, which lifts it above the flat scrim anyway.
  //
  // Both children are absolutely positioned, so neither reserves layout space
  // and the tab bar's measured height stays exactly PILL_HEIGHT.
  const renderTabBar = useCallback(
    (props: BottomTabBarProps) => (
      <>
        <TabBarScrim />
        <BottomTabBar {...props} />
      </>
    ),
    [],
  );

  return (
    <>
      <ConnectionBanner />
      <Tab.Navigator
        tabBar={renderTabBar}
        screenOptions={{
          headerShown: false,
          // A FLOATING pill, not a shelf. `position: 'absolute'` lifts the bar
          // out of the flex flow, so the tab scene fills the whole navigator and
          // the screen's own themed background — plus its scrolling content —
          // runs underneath and around the rounded corners. Nothing opaque is
          // left behind the bar to leak through; that leak was react-navigation's
          // white DefaultTheme background, now themed on NavigationContainer.
          //
          // The float is paid for in `useTabBarInset()`: an absolute tab bar
          // reserves no layout space, so every scrollable screen pads its
          // content by that much. See src/theme/tabBar.ts.
          tabBarStyle: {
            position: 'absolute',
            // Overrides BottomTabBar's own `start/end/bottom: 0`. These are the
            // logical (`start`/`end`) props on purpose — Yoga resolves them
            // ahead of left/right, so setting left/right here would lose.
            start: TAB_BAR_PILL_GAP,
            end: TAB_BAR_PILL_GAP,
            bottom: pillBottom,
            height: TAB_BAR_PILL_HEIGHT,
            // BottomTabBar pads itself by insets.bottom to clear the home
            // indicator. The pill clears it by sitting ABOVE it instead, so that
            // padding has to go or the glyphs ride up inside the pill.
            paddingBottom: 0,
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.lg,
            // BottomTabBar hardcodes a hairline TOP border; a pill needs all
            // four. borderTopWidth is more specific than borderWidth no matter
            // the merge order, so it must be restated explicitly.
            borderWidth: 1,
            borderTopWidth: 1,
            borderColor: theme.colors.border,
            // Reads as floating rather than pasted on.
            ...theme.shadows.raised,
          },
          // Belt and braces behind the pill: the tab scene paints theme bg even
          // mid-transition, before a screen's own root View has laid out.
          sceneStyle: {
            backgroundColor: theme.colors.bg,
          },
          tabBarActiveTintColor: theme.colors.accent,
          tabBarInactiveTintColor: theme.colors.textMuted,
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '600',
          },
        }}
      >
        <Tab.Screen
          name="Compose"
          options={{
            tabBarIcon: ({ focused, color }) => (
              <TabIcon name="compose" focused={focused} color={color} />
            ),
          }}
        >
          {() => (
            <ComposeScreen
              sharedText={sharedText}
              onSharedTextConsumed={() => setSharedText(null)}
              sharedImage={sharedImage}
              onSharedImageConsumed={() => setSharedImage(null)}
            />
          )}
        </Tab.Screen>

        <Tab.Screen
          name="History"
          component={HistoryScreen}
          options={{
            tabBarIcon: ({ focused, color }) => (
              <TabIcon name="history" focused={focused} color={color} />
            ),
          }}
        />

        {hostOnly && (
          <>
            <Tab.Screen
              name="Wallpaper"
              component={WallpaperScreen}
              options={{
                tabBarIcon: ({ focused, color }) => (
                  <TabIcon name="wallpaper" focused={focused} color={color} />
                ),
              }}
            />

            {/* NO CONNECTIVITY GATE ON THIS TAB, deliberately.
                It used to preventDefault() the press and alert 'Not connected'
                whenever the reader was unreachable — which is the reader's
                NORMAL state (deep sleep turns its WiFi off), so the whole
                offline half of the Library was unreachable: the cached reader
                listing, the live mailbox queue, and queueing an add for the next
                sync window. The screen renders a quiet per-side state for each of
                those and gates its own writes (`canAddBooks`, the host checks on
                the delete paths), so the tab has nothing left to refuse. The
                icon's old `opacity: connected ? 1 : 0.4` went with it: it made
                the same false 'disabled' claim. */}
            <Tab.Screen
              name="Device"
              component={DeviceScreen}
              options={{
                // LABEL ONLY. The route is still named 'Device' (renaming it
                // would move every navigate() target); the tab shows 'Library'
                // because the screen leads with the merged book list now and the
                // raw file manager is the collapsed section under it.
                title: 'Library',
                tabBarIcon: ({ focused, color }) => (
                  <TabIcon name="device" focused={focused} color={color} />
                ),
              }}
            />
          </>
        )}

        {/* Route name is 'SettingsTab', not 'Settings', so it does not collide
            with the modal Stack route of that name (ConnectionBanner's gear icon
            still navigates to the stack one). The visible label is 'Settings'. */}
        <Tab.Screen
          name="SettingsTab"
          component={SettingsScreen}
          options={{
            title: 'Settings',
            tabBarIcon: ({ focused, color }) => (
              <TabIcon name="settings" focused={focused} color={color} />
            ),
          }}
        />
      </Tab.Navigator>
    </>
  );
}

function AppContent() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const navigationRef = useRef<any>(null);
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  // React Navigation keeps its OWN palette, and without this it is
  // DefaultTheme — a static near-white. That palette is not decorative: it
  // paints @react-navigation/elements' <Background> behind every scene, the
  // native-stack view controller, and the tab bar's default card color. Left
  // unthemed it showed as white around the floating pill's rounded corners in
  // BOTH schemes, which is the bug this mapping fixes.
  const navigationTheme = useMemo<NavigationTheme>(() => {
    const base = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;

    return {
      ...base,
      dark: theme.scheme === 'dark',
      colors: {
        ...base.colors,
        primary: theme.colors.accent,
        background: theme.colors.bg,
        card: theme.colors.surface,
        text: theme.colors.text,
        border: theme.colors.border,
        notification: theme.colors.danger,
      },
    };
  }, [theme]);

  // Share intent state — Compose is the single owner of both payload kinds.
  const [sharedText, setSharedText] = useState<string | null>(null);
  const [sharedImage, setSharedImage] = useState<SharedImage | null>(null);

  // Handle incoming share intents
  useEffect(() => {
    if (!hasShareIntent) return;

    // Handle shared images
    if ((shareIntent.type === 'media' || shareIntent.type === 'file') && shareIntent.files && shareIntent.files.length > 0) {
      const file = shareIntent.files[0];

      setSharedImage({
        uri: file.path,
        // Carry the source name verbatim — each destination picks its own output
        // name (current.frame for love-notes, sleep.bmp for wallpaper).
        filename: file.fileName || `shared_${Date.now()}`,
        width: file.width ?? undefined,
        height: file.height ?? undefined,
      });

      setTimeout(() => {
        navigationRef.current?.navigate('MainTabs', { screen: 'Compose' });
      }, 100);

      resetShareIntent();
      return;
    }

    // Handle shared text (plain text and URLs alike — both are just note content now)
    if (shareIntent.type === 'text' || shareIntent.type === 'weburl') {
      const sharedValue = shareIntent.type === 'weburl'
        ? shareIntent.webUrl
        : shareIntent.text;

      if (sharedValue && sharedValue.trim().length > 0) {
        setSharedText(sharedValue);

        setTimeout(() => {
          navigationRef.current?.navigate('MainTabs', { screen: 'Compose' });
        }, 100);
      }

      resetShareIntent();
    }
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  return (
    <NavigationContainer ref={navigationRef} theme={navigationTheme}>
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            presentation: 'modal',
            contentStyle: { backgroundColor: theme.colors.bg },
          }}
        >
          <Stack.Screen name="MainTabs">
            {() => (
              <MainTabs
                sharedText={sharedText}
                setSharedText={setSharedText}
                sharedImage={sharedImage}
                setSharedImage={setSharedImage}
              />
            )}
          </Stack.Screen>
          {/* Settings is also a tab now; this route stays as an alias because
              ConnectionBanner's gear icon navigates to it by name. */}
          <Stack.Screen name="Settings" component={SettingsScreen} />
        </Stack.Navigator>
      </SafeAreaView>
    </NavigationContainer>
  );
}

export default function App() {
  const [appIsReady, setAppIsReady] = useState(false);
  const theme = useTheme();

  // app.config.ts pins the native window background to a STATIC #F6EEDF (the
  // light theme's cream) because that value is read before any JS exists. In dark
  // mode that cream is what shows during the splash gate below — which renders
  // `null` — and in any gap where no themed view covers the window. Retint the
  // native root as soon as the scheme is known. Sits above the `appIsReady`
  // early return on purpose, so it fires during the gate, not after it.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.colors.bg).catch(() => {
      // Cosmetic only; a failure here must never block startup.
    });
  }, [theme.colors.bg]);

  useEffect(() => {
    async function prepare() {
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (e) {
        console.warn(e);
      } finally {
        setAppIsReady(true);
      }
    }
    prepare();
  }, []);

  const onLayoutRootView = useCallback(async () => {
    if (appIsReady) {
      await SplashScreen.hideAsync();
    }
  }, [appIsReady]);

  if (!appIsReady) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <SafeAreaProvider onLayout={onLayoutRootView}>
        {/* Follows the palette, not a constant: the light theme's background is
            warm cream, and a hardcoded `light` status bar paints white glyphs
            onto it — invisible. */}
        <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
        <ConnectionProvider>
          <ProgressProvider>
            <AppContent />
          </ProgressProvider>
        </ConnectionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function createStyles(theme: Theme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.colors.bg,
    },
  });
}
