import React, { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { supabase } from "./lib/supabase";
import type { Session } from "@supabase/supabase-js";

import { colors } from './lib/tokens';
import LoginScreen from "./screens/Login";
import PropertiesScreen from "./screens/Properties";
import PropertyTrainingScreen from "./screens/PropertyTraining";
import InspectionStartScreen from "./screens/InspectionStart";
import InspectionCameraScreen from "./screens/InspectionCamera";
import InspectionSummaryScreen from "./screens/InspectionSummary";
import InspectionHistoryScreen from "./screens/InspectionHistory";
import PropertyDetailScreen from "./screens/PropertyDetail";
import ProfileScreen from "./screens/Profile";
import ReportIssueScreen from "./screens/ReportIssue";
import type { ImageSourceType } from "./lib/image-source/types";

export type InspectionMode =
  | "turnover"
  | "maintenance"
  | "owner_arrival"
  | "vacancy_check";

export interface SummaryFindingData {
  id: string;
  description: string;
  severity: string;
  confidence: number;
  category: string;
  roomName: string;
  status?: string;
  source?: "manual_note" | "ai";
  resultId?: string;
  findingIndex?: number;
}

export interface SummaryRoomData {
  roomId: string;
  roomName: string;
  score: number | null;
  coverage: number;
  anglesScanned: number;
  anglesTotal: number;
  confirmedFindings: number;
  findings: SummaryFindingData[];
}

export interface SummaryData {
  overallScore: number | null;
  completionTier: string;
  overallCoverage: number;
  durationMs: number;
  inspectionMode: string;
  rooms: SummaryRoomData[];
  confirmedFindings: SummaryFindingData[];
}

export type RootStackParamList = {
  Login: undefined;
  Properties: undefined;
  Profile: undefined;
  ReportIssue: { prefillError?: string; prefillScreen?: string } | undefined;
  PropertyDetail: { propertyId: string };
  InspectionHistory: { propertyId: string; propertyName?: string };
  PropertyTraining: { propertyId: string; propertyName: string };
  InspectionStart: { propertyId: string };
  InspectionCamera: {
    inspectionId: string;
    propertyId: string;
    inspectionMode: InspectionMode;
    imageSource?: ImageSourceType;
  };
  InspectionSummary: {
    inspectionId: string;
    propertyId: string;
    summaryData?: SummaryData;
  };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function Navigation() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data: { session: s } }) => {
        setSession(s);
        setLoading(false);
      })
      .catch(() => {
        // Auth check failed (network error, corrupt storage) — show login
        setLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: "slide_from_right",
        }}
      >
        {session ? (
          <>
            <Stack.Screen name="Properties" component={PropertiesScreen} />
            <Stack.Screen
              name="PropertyDetail"
              component={PropertyDetailScreen}
            />
            <Stack.Screen
              name="InspectionHistory"
              component={InspectionHistoryScreen}
            />
            <Stack.Screen
              name="PropertyTraining"
              component={PropertyTrainingScreen}
            />
            <Stack.Screen
              name="InspectionStart"
              component={InspectionStartScreen}
            />
            <Stack.Screen
              name="InspectionCamera"
              component={InspectionCameraScreen}
              options={{ gestureEnabled: false }}
            />
            <Stack.Screen
              name="InspectionSummary"
              component={InspectionSummaryScreen}
            />
            <Stack.Screen name="Profile" component={ProfileScreen} />
            <Stack.Screen name="ReportIssue" component={ReportIssueScreen} />
          </>
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
