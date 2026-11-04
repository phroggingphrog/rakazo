import DateTimePicker from "@expo/ui/community/datetime-picker";
import { useState } from "react";
import { Modal, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export function RoutineRearm({
  saving,
  onCancel,
  onSave,
}: {
  saving: boolean;
  onCancel: () => void;
  onSave: (at: Date) => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [at, setAt] = useState(() => new Date(Date.now() + 60 * 60 * 1000));
  return (
    <Modal
      visible
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!saving) onCancel();
      }}
    >
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        <Text accessibilityRole="header" style={styles.title}>
          {t("Run at")}
        </Text>
        <View
          style={styles.picker}
          pointerEvents={saving ? "none" : "auto"}
          accessibilityElementsHidden={saving}
          importantForAccessibility={saving ? "no-hide-descendants" : "auto"}
        >
          <DateTimePicker
            value={at}
            style={styles.pickerControl}
            mode={Platform.OS === "ios" ? "datetime" : "date"}
            disabled={saving}
            presentation="inline"
            onValueChange={(_, value) => setAt(value)}
          />
          {Platform.OS !== "ios" ? (
            <DateTimePicker
              value={at}
              style={styles.pickerControl}
              mode="time"
              disabled={saving}
              presentation="inline"
              onValueChange={(_, value) => setAt(value)}
            />
          ) : null}
        </View>
        <NativeActionButton label={t("Save")} busy={saving} onPress={() => onSave(at)} />
        <NativeActionButton
          label={t("Cancel")}
          prominence="secondary"
          disabled={saving}
          onPress={onCancel}
        />
      </ScrollView>
    </Modal>
  );
}

function createStyles() {
  return StyleSheet.create({
    content: { flexGrow: 1, padding: 24, gap: 16, backgroundColor: native.groupedPage },
    title: { fontSize: 20, fontWeight: "600", color: native.label },
    picker: { alignItems: "stretch" },
    pickerControl: { width: "100%" },
  });
}
