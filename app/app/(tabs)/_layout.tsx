/**
 * The five tabs.
 *
 * Named for what you do with them, not for the data behind them. "Position" rather than "Home",
 * because the question that brings someone back to this app daily is *where do I stand* — and
 * "Next" rather than "Recommendations", because the answer is a card to apply for, not a list to
 * browse.
 */

import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { colour, font } from '@/theme.ts';

/**
 * The tab bar's colour, as the icon set will accept it.
 *
 * React Navigation types a colour as `string | number | OpaqueColorValue | null` — the number being
 * an Android resource id — while `@expo/vector-icons` takes only the string form. Narrowed once here
 * rather than cast at each of the five call sites.
 */
function iconColour(colourValue: string | number | { toString(): string } | null | undefined): string | undefined {
  return typeof colourValue === 'string' ? colourValue : undefined;
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colour.ground },
        headerShadowVisible: false,
        headerTintColor: colour.text,
        headerTitleStyle: { fontFamily: font.display, fontSize: 17, letterSpacing: -0.3 },
        sceneStyle: { backgroundColor: colour.ground },
        tabBarStyle: {
          backgroundColor: colour.ground,
          borderTopColor: colour.line,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: colour.text,
        tabBarInactiveTintColor: colour.textFaint,
        tabBarLabelStyle: { fontFamily: font.bodyMedium, fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Position',
          tabBarIcon: ({ color, size }) => <Ionicons name="grid-outline" size={size} color={iconColour(color)} />,
        }}
      />
      <Tabs.Screen
        name="cards"
        options={{
          title: 'Cards',
          tabBarIcon: ({ color, size }) => <Ionicons name="card-outline" size={size} color={iconColour(color)} />,
        }}
      />
      <Tabs.Screen
        name="banks"
        options={{
          title: 'Banks',
          tabBarIcon: ({ color, size }) => <Ionicons name="business-outline" size={size} color={iconColour(color)} />,
        }}
      />
      <Tabs.Screen
        name="plan"
        options={{
          title: 'Next',
          tabBarIcon: ({ color, size }) => <Ionicons name="navigate-outline" size={size} color={iconColour(color)} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Ionicons name="options-outline" size={size} color={iconColour(color)} />,
        }}
      />
    </Tabs>
  );
}
