import type { Routine } from "@rakazo/contracts";
import { isOneShotRoutineCrons } from "@rakazo/core";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, View } from "react-native";
import { EmailMonitorSetup } from "../components/email-monitor-setup";
import { NativeActionButton } from "../components/native-action-button";
import { RoutineList } from "../components/routine-list";
import { RoutineRearm } from "../components/routine-rearm";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { deviceTimeZone } from "../lib/routine";
import {
  loadBotRoutines,
  rearmBotRoutine,
  removeBotRoutine,
  routineScope,
  setRoutineActive,
  useBotRoutines,
} from "../lib/routine-store";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function Routines() {
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const { botId = "", name } = useLocalSearchParams<{ botId?: string; name?: string }>();
  const { routines, error } = useBotRoutines(botId);
  const [deleting, setDeleting] = useState(false);
  const [rearming, setRearming] = useState<{ routine: Routine; scope: string } | null>(null);
  const [rearmSaving, setRearmSaving] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const rearmInFlight = useRef(false);

  useEffect(() => setSetupOpen(false), [botId]);
  useFocusEffect(useCallback(() => () => setSetupOpen(false), []));

  const setupLauncher =
    botId && (Platform.OS === "ios" || Platform.OS === "android") ? (
      <NativeActionButton
        label={t("Set up source monitor")}
        prominence="secondary"
        onPress={() => setSetupOpen(true)}
      />
    ) : null;
  const setupSheet = setupOpen ? (
    <EmailMonitorSetup
      botId={botId}
      botName={name ?? t("Bot")}
      onClose={() => setSetupOpen(false)}
      onOpenIntegrations={() => {
        setSetupOpen(false);
        router.push("/integrations");
      }}
      onConfigured={() => void loadBotRoutines(botId)}
    />
  ) : null;

  async function rearm(at: Date) {
    if (!rearming || rearmInFlight.current) return;
    rearmInFlight.current = true;
    setRearmSaving(true);
    try {
      await rearmBotRoutine(botId, rearming.routine, at, rearming.scope);
      setRearming(null);
    } catch (cause) {
      Alert.alert(t("Could not update routine"), errorText(cause, t("Try again.")));
    } finally {
      rearmInFlight.current = false;
      setRearmSaving(false);
    }
  }

  async function remove(routine: Routine) {
    setDeleting(true);
    try {
      await removeBotRoutine(botId, routine.id);
    } catch (cause) {
      Alert.alert(t("Could not delete routine"), errorText(cause, t("Try again.")));
    } finally {
      setDeleting(false);
    }
  }

  function confirmDelete(routine: Routine) {
    if (deleting) return;
    Alert.alert(
      routine.name.trim()
        ? t('Delete "{name}"?', { name: routine.name })
        : t("Delete this routine?"),
      t("This permanently deletes the routine and its run history."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Delete"), style: "destructive", onPress: () => void remove(routine) },
      ],
    );
  }

  if (routines?.length) {
    return (
      <>
        <RoutineList
          routines={routines}
          header={setupLauncher}
          timeZone={deviceTimeZone()}
          canDelete={!deleting}
          onOpen={(routine) =>
            router.push({
              pathname: "/routine",
              params: { botId, botName: name, routineId: routine.id, origin: "profile" },
            })
          }
          onToggle={(routine, active) => {
            if (active && isOneShotRoutineCrons(routine.crons) && !routine.nextRunAt) {
              if (Platform.OS !== "ios" && Platform.OS !== "android") {
                Alert.alert(
                  t("Choose a new time"),
                  t("Open the routine editor to choose a new time."),
                );
                return;
              }
              setRearming({ routine, scope: routineScope(botId) });
              return;
            }
            setRoutineActive(botId, routine, active, (cause) =>
              Alert.alert(t("Could not update routine"), errorText(cause, t("Try again."))),
            );
          }}
          onDelete={confirmDelete}
        />
        {rearming ? (
          <RoutineRearm
            saving={rearmSaving}
            onCancel={() => setRearming(null)}
            onSave={(at) => void rearm(at)}
          />
        ) : null}
        {setupSheet}
      </>
    );
  }
  return (
    <View style={[styles.empty, sideInsets]}>
      {routines ? (
        // There is no add button here: routines are set up by asking the bot.
        <>
          <Text style={styles.message}>{t("Ask this Bot in chat to set up a routine.")}</Text>
          {setupLauncher}
          {setupSheet}
        </>
      ) : error ? (
        <>
          <Text style={styles.message}>{t("Could not load routines")}</Text>
          <NativeActionButton
            label={t("Try Again")}
            variant="text"
            prominence="secondary"
            style={styles.retry}
            onPress={() => void loadBotRoutines(botId)}
          />
        </>
      ) : (
        <ActivityIndicator color={native.secondaryLabel} />
      )}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    empty: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 32,
      gap: 8,
      backgroundColor: native.groupedPage,
    },
    message: { color: native.secondaryLabel, fontSize: 17, textAlign: "center" },
    // The button aligns itself to the start by default.
    retry: { alignSelf: "center" },
  });
}
