import DateTimePicker from "@expo/ui/community/datetime-picker";
import {
  type McpServer,
  type RoutineRun,
  type RpcOutput,
  SetupOperationArgumentsSchema,
  setupArgumentFields,
  updateSetupArgumentText,
} from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { MonitorDraft, MonitorPlan, MonitorSetupSession } from "../lib/email-monitor-setup";
import { openMonitorSetup } from "../lib/email-monitor-setup";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { deviceTimeZone } from "../lib/routine";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";

type Frequency = "hourly" | "daily" | "weekdays" | "custom";
type Catalog = RpcOutput<"setupPlans/previewReads">;
type Prerequisites = RpcOutput<"setupPlans/prerequisites">;
type Candidates = RpcOutput<"setupPlans/discoverCandidates">;
type SourceTestStatus =
  | NonNullable<RoutineRun["sourceTest"]>
  | "not_checked"
  | "unavailable"
  | "unbound";

function initialTime(hour = 9, minute = 0): Date {
  const time = new Date();
  time.setHours(hour, minute, 0, 0);
  return time;
}

function parseSchedule(cron: string): { frequency: Frequency; time: Date } {
  if (cron === "0 * * * *") return { frequency: "hourly", time: initialTime() };
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(cron);
  if (match && Number(match[1]) < 60 && Number(match[2]) < 24) {
    return {
      frequency: match[3] === "*" ? "daily" : "weekdays",
      time: initialTime(Number(match[2]), Number(match[1])),
    };
  }
  return { frequency: "custom", time: initialTime() };
}

function scheduleCron(frequency: Frequency, time: Date, custom: string): string {
  if (frequency === "custom") return custom;
  if (frequency === "hourly") return "0 * * * *";
  return `${time.getMinutes()} ${time.getHours()} * * ${frequency === "daily" ? "*" : "1-5"}`;
}

export function EmailMonitorSetup({
  botId,
  botName,
  onClose,
  onOpenIntegrations,
  onConfigured,
}: {
  botId: string;
  botName: string;
  onClose: () => void;
  onOpenIntegrations: () => void;
  onConfigured?: () => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const mounted = useRef(true);
  const pending = useRef(false);
  const testReadGeneration = useRef(0);
  const [session, setSession] = useState<MonitorSetupSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [plans, setPlans] = useState<MonitorPlan[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [plan, setPlan] = useState<MonitorPlan | null>(null);
  const [purpose, setPurpose] = useState("");
  const [serverId, setServerId] = useState("");
  const [sourceRevision, setSourceRevision] = useState<number | null>(null);
  const [toolName, setToolName] = useState("");
  const [argumentText, setArgumentText] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [time, setTime] = useState(initialTime);
  const [customCron, setCustomCron] = useState("");
  const [timezone, setTimezone] = useState(() => deviceTimeZone() ?? "UTC");
  const [notify, setNotify] = useState(true);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [grantStatus, setGrantStatus] = useState<"allowed" | null>(null);
  const [prerequisites, setPrerequisites] = useState<Prerequisites | null>(null);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [sourceTestStatus, setSourceTestStatus] = useState<SourceTestStatus>("not_checked");
  const [restoredTest, setRestoredTest] = useState(false);
  const [planSelection, setPlanSelection] = useState(0);
  const [routineActive, setRoutineActive] = useState<boolean | null>(null);
  const [routineStateError, setRoutineStateError] = useState(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    setBusy(true);
    openMonitorSetup(botId)
      .then(async (opened) => {
        if (active && opened.current()) setSession(opened);
        return { opened, loaded: await opened.load() };
      })
      .then(({ opened, loaded }) => {
        if (!active || !opened.current()) return;
        setSession(opened);
        setServers(loaded.servers);
        setPlans(loaded.plans);
        setCursor(loaded.nextCursor);
      })
      .catch((cause) => {
        if (active) setError(errorText(cause, t("Could not open setup")));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [botId]);

  useEffect(() => {
    let active = true;
    setRoutineActive(null);
    setRoutineStateError(false);
    if (session && plan?.status === "configured" && plan.routineId) {
      void session.routineState(plan).then(
        (value) => {
          if (active && session.current()) setRoutineActive(value);
        },
        () => {
          if (active && session.current()) setRoutineStateError(true);
        },
      );
    }
    return () => {
      active = false;
    };
  }, [session, plan?.id, plan?.routineId, plan?.status]);

  useEffect(() => {
    const generation = ++testReadGeneration.current;
    if (session && plan?.status === "configured" && plan.routineId) {
      void session.latestSourceTest(plan).then(
        (latest) => {
          if (
            !mounted.current ||
            !session.current() ||
            testReadGeneration.current !== generation ||
            !latest
          )
            return;
          setTestRunId(latest.runId);
          setTestStatus(latest.runStatus);
          setSourceTestStatus(latest.sourceTest);
          setRestoredTest(true);
        },
        () => undefined,
      );
    }
    return () => {
      if (testReadGeneration.current === generation) testReadGeneration.current += 1;
    };
  }, [session, plan?.id, plan?.revision, plan?.routineId, plan?.status, planSelection]);

  const testFinished = ["completed", "failed", "cancelled"].includes(testStatus ?? "");
  useEffect(() => {
    if (!session || !plan || !testRunId || testFinished) return;
    let active = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!active || !session.current()) return;
      const generation = ++testReadGeneration.current;
      attempts += 1;
      try {
        const status = await session.testStatus(plan, testRunId);
        if (!active || !mounted.current || !session.current()) return;
        if (testReadGeneration.current === generation) {
          setTestStatus(status.runStatus);
          setSourceTestStatus(status.sourceTest);
          if (["completed", "failed", "cancelled"].includes(status.runStatus)) return;
        }
      } catch {
        // The existing manual refresh remains available if the bounded polling window expires.
      }
      if (active && attempts < 20) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [session, plan, testRunId, testFinished]);

  function clearCheck() {
    setPrerequisites(null);
    setCandidates(null);
    setError(null);
  }

  function loadPlan(next: MonitorPlan) {
    testReadGeneration.current += 1;
    setPlanSelection((value) => value + 1);
    setTestRunId(null);
    setTestStatus(null);
    setSourceTestStatus("not_checked");
    setRestoredTest(false);
    const savedSchedule = next.draft.schedule;
    const parsed = savedSchedule
      ? parseSchedule(savedSchedule.cron)
      : { frequency: "daily" as const, time: initialTime() };
    setPlan(next);
    setPurpose(next.draft.purpose);
    setServerId(next.draft.source?.serverId ?? "");
    setSourceRevision(next.draft.source?.revision ?? null);
    setToolName(next.draft.source?.toolName ?? "");
    setArgumentText(
      next.draft.arguments === undefined ? "" : JSON.stringify(next.draft.arguments, null, 2),
    );
    setFrequency(parsed.frequency);
    setTime(parsed.time);
    setCustomCron(savedSchedule?.cron ?? "");
    setTimezone(savedSchedule?.timezone ?? deviceTimeZone() ?? "UTC");
    setNotify(next.draft.notify);
    setCatalog(null);
    setGrantStatus(null);
    clearCheck();
  }

  function newProposal() {
    testReadGeneration.current += 1;
    setPlan(null);
    setTestRunId(null);
    setTestStatus(null);
    setSourceTestStatus("not_checked");
    setRestoredTest(false);
    setPurpose("");
    setServerId("");
    setSourceRevision(null);
    setToolName("");
    setArgumentText("");
    setFrequency("daily");
    setTime(initialTime());
    setCustomCron("");
    setTimezone(deviceTimeZone() ?? "UTC");
    setNotify(true);
    setCatalog(null);
    setGrantStatus(null);
    clearCheck();
  }

  async function perform(work: () => Promise<void>) {
    if (pending.current || !session) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      if (mounted.current && session.current())
        setError(errorText(cause, t("Could not update setup")));
      else if (mounted.current) onClose();
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  let parsedArguments: MonitorDraft["arguments"];
  let invalidArguments = false;
  if (argumentText.trim()) {
    try {
      const parsed = SetupOperationArgumentsSchema.safeParse(JSON.parse(argumentText));
      if (parsed.success) parsedArguments = parsed.data;
      else invalidArguments = true;
    } catch {
      invalidArguments = true;
    }
  }
  const argumentValues = parsedArguments as Record<string, unknown> | undefined;
  const argumentSchema = catalog?.tools.find((tool) => tool.name === toolName)?.inputSchema;
  const guidedFields = setupArgumentFields(argumentSchema).filter((field) => {
    const value = argumentValues?.[field.name];
    return (
      value === undefined ||
      (field.kind === "boolean"
        ? typeof value === "boolean"
        : typeof value === "string" && (field.kind !== "choice" || field.choices.includes(value)))
    );
  });
  const argumentFields = argumentSchema?.properties;
  const requiredFields = Array.isArray(argumentSchema?.required)
    ? argumentSchema.required
        .filter((field): field is string => typeof field === "string")
        .slice(0, 20)
    : [];
  const draft: MonitorDraft = {
    kind: "email_monitor",
    purpose: purpose.trim(),
    ...(parsedArguments === undefined ? {} : { arguments: parsedArguments }),
    botId,
    source:
      serverId && sourceRevision && toolName
        ? { serverId, revision: sourceRevision, toolName }
        : null,
    schedule: { cron: scheduleCron(frequency, time, customCron), timezone },
    notify,
  };
  const dirty = invalidArguments || !plan || JSON.stringify(draft) !== JSON.stringify(plan.draft);
  const checked =
    !dirty &&
    prerequisites?.planRevision === plan?.revision &&
    candidates?.planRevision === plan?.revision;
  const canPropose =
    checked &&
    prerequisites?.bot === "available" &&
    prerequisites.source === "available" &&
    prerequisites.assignment === "configured" &&
    prerequisites.selectedTool === "allowed" &&
    candidates?.status === "ok" &&
    candidates.selectedOperation === "declared_read";
  const editable = !busy && plan?.status !== "configured";

  function changeArgument(name: string, value: string | boolean | undefined) {
    setArgumentText((current) => updateSetupArgumentText(current, name, value) ?? current);
    clearCheck();
  }

  async function discover() {
    if (!session || !serverId) return;
    const result = await session.discover(serverId);
    if (!mounted.current || !session.current()) return;
    setCatalog(result);
    setGrantStatus(null);
    setSourceRevision(result.revision);
    setToolName("");
    setArgumentText("");
    clearCheck();
  }

  async function grantRead() {
    if (!session || !serverId || sourceRevision === null || !toolName) return;
    const result = await session.grantRead(serverId, sourceRevision, toolName);
    if (!mounted.current || !session.current()) return;
    setGrantStatus(result.status);
    clearCheck();
  }

  async function save() {
    if (!session) return;
    if (invalidArguments) {
      setError(t("Enter a valid JSON object up to 8 KB."));
      return;
    }
    if (!draft.purpose) {
      setError(t("Describe what the agent should watch."));
      return;
    }
    if (!draft.source) {
      setError(t("Choose an integration and a read operation."));
      return;
    }
    const result = await session.save(draft, plan);
    if (!mounted.current || !session.current()) return;
    setPlan(result);
    setPlans((items) => [result, ...items.filter((item) => item.id !== result.id)]);
    clearCheck();
  }

  async function check() {
    if (!session || !plan || dirty) return;
    const result = await session.prerequisites(plan);
    if (!mounted.current || !session.current()) return;
    setPrerequisites(result);
    setCandidates(null);
    if (
      result.bot !== "available" ||
      result.source !== "available" ||
      result.assignment !== "configured" ||
      result.selectedTool !== "allowed"
    )
      return;
    const found = await session.candidates(plan);
    if (mounted.current && session.current()) setCandidates(found);
  }

  async function propose() {
    if (!session || !plan || !canPropose) return;
    const result = await session.propose(plan);
    if (!mounted.current || !session.current()) return;
    setPlan(result);
    setPlans((items) => items.map((item) => (item.id === result.id ? result : item)));
    clearCheck();
  }

  async function configure() {
    if (!session || !plan || plan.status !== "proposed" || !canPropose) return;
    const result = await session.configure(plan);
    if (!mounted.current || !session.current()) return;
    setPlan(result);
    setPlans((items) => items.map((item) => (item.id === result.id ? result : item)));
    clearCheck();
    onConfigured?.();
  }

  async function runTest() {
    if (!session || !plan || plan.status !== "configured" || !plan.routineId) return;
    const generation = ++testReadGeneration.current;
    const result = await session.runTest(plan);
    if (mounted.current && session.current() && testReadGeneration.current === generation) {
      setTestRunId(result.runId);
      setTestStatus("not checked");
      setSourceTestStatus("not_checked");
      setRestoredTest(false);
    }
  }

  async function refreshTest() {
    if (!session || !plan || !testRunId) return;
    const generation = ++testReadGeneration.current;
    const status = await session.testStatus(plan, testRunId);
    if (mounted.current && session.current() && testReadGeneration.current === generation) {
      setTestStatus(status.runStatus);
      setSourceTestStatus(status.sourceTest);
    }
  }

  async function setActive(active: boolean) {
    if (!session || !plan?.routineId) return;
    const value = await session.setRoutineActive(plan, active);
    if (mounted.current && session.current()) {
      setRoutineActive(value);
      onConfigured?.();
    }
  }

  async function refresh(more = false) {
    if (!session || (more && !cursor)) return;
    const result = await session.load(more ? (cursor ?? undefined) : undefined);
    if (!mounted.current || !session.current()) return;
    setServers(result.servers);
    setPlans((items) => (more ? [...items, ...result.plans] : result.plans));
    setCursor(result.nextCursor);
  }

  function openIntegrations() {
    if (dirty && purpose.trim()) {
      Alert.alert(t("Open integrations?"), t("Unsaved changes will be lost."), [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Open"), onPress: onOpenIntegrations },
      ]);
    } else onOpenIntegrations();
  }

  function close() {
    if (busy) return;
    if (dirty && (purpose.trim() || serverId || toolName)) {
      Alert.alert(t("Discard unsaved changes?"), t("Your saved proposals will remain available."), [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Discard"), style: "destructive", onPress: onClose },
      ]);
    } else onClose();
  }

  const integrationChoices = [
    { key: "", label: t("Choose an integration") },
    ...(serverId && !servers.some((server) => server.id === serverId)
      ? [{ key: serverId, label: t("Unavailable integration") }]
      : []),
    ...servers.map((server) => ({ key: server.id, label: server.name })),
  ];
  const operationChoices = [
    { key: "", label: t("Choose an operation") },
    ...(toolName && !catalog?.tools.some((tool) => tool.name === toolName)
      ? [{ key: toolName, label: toolName }]
      : []),
    ...(catalog?.tools ?? []).map((tool) => ({ key: tool.name, label: tool.name })),
  ];

  return (
    <Modal visible presentationStyle="pageSheet" onRequestClose={close}>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
        >
          <Text accessibilityRole="header" style={styles.title}>
            {t("Source monitor")}
          </Text>
          <Text style={styles.secondary}>{botName}</Text>
          <Text style={styles.secondary}>
            {plan?.status === "configured"
              ? t("This setup is saved. Its routine status and available actions appear below.")
              : t("Saving a proposal does not start a routine or read the source.")}
          </Text>

          {plans.length ? (
            <MenuPicker
              disabled={busy}
              label={t("Saved proposals")}
              value={plan?.id ?? ""}
              choices={[
                { key: "", label: t("Choose a proposal") },
                ...plans.map((item) => ({ key: item.id, label: item.draft.purpose })),
              ]}
              onChange={(id) => {
                const next = plans.find((item) => item.id === id);
                if (next) loadPlan(next);
              }}
            />
          ) : null}
          {cursor ? (
            <NativeActionButton
              label={t("Load more proposals")}
              disabled={busy}
              prominence="secondary"
              onPress={() => void perform(() => refresh(true))}
            />
          ) : null}
          {plan ? (
            <NativeActionButton
              label={t("New proposal")}
              disabled={busy || dirty}
              prominence="secondary"
              onPress={newProposal}
            />
          ) : null}

          <Text style={styles.label}>{t("What should {name} watch for?", { name: botName })}</Text>
          <TextInput
            accessibilityLabel={t("What should {name} watch for?", { name: botName })}
            value={purpose}
            editable={editable}
            maxLength={2000}
            multiline
            textAlignVertical="top"
            style={styles.input}
            onChangeText={(value) => {
              setPurpose(value);
              clearCheck();
            }}
          />
          <MenuPicker
            disabled={!editable}
            label={t("Integration")}
            choices={integrationChoices}
            value={serverId}
            onChange={(next) => {
              setServerId(next);
              setSourceRevision(servers.find((server) => server.id === next)?.revision ?? null);
              setToolName("");
              setArgumentText("");
              setCatalog(null);
              setGrantStatus(null);
              clearCheck();
            }}
          />
          <NativeActionButton
            label={t("Find read operations")}
            disabled={!editable || !serverId}
            prominence="secondary"
            onPress={() => void perform(discover)}
          />
          {catalog?.status === "not_assigned" ? (
            <Text accessibilityRole="alert" style={styles.secondary}>
              {t("Assign this integration to the bot first.")}
            </Text>
          ) : null}
          {catalog?.status === "unavailable" ? (
            <Text accessibilityRole="alert" style={styles.secondary}>
              {t("This integration is unavailable.")}
            </Text>
          ) : null}
          {catalog?.status === "ok" || toolName ? (
            <MenuPicker
              disabled={!editable}
              label={t("Read operation")}
              choices={operationChoices}
              value={toolName}
              onChange={(name) => {
                setToolName(name);
                setGrantStatus(null);
                setArgumentText("");
                clearCheck();
              }}
            />
          ) : null}
          {catalog?.status === "ok" && toolName && editable ? (
            <>
              <Text style={styles.secondary}>
                {t("Allow the selected read operation without changing other bot access.")}
              </Text>
              <NativeActionButton
                label={t("Allow selected read")}
                disabled={busy}
                prominence="secondary"
                onPress={() => void perform(grantRead)}
              />
              {grantStatus ? (
                <Text accessibilityLiveRegion="polite" style={styles.secondary}>
                  {t("Selected read is allowed in bot settings.")}
                </Text>
              ) : null}
            </>
          ) : null}
          {toolName ? (
            <View>
              {guidedFields.length ? (
                <View style={styles.guidedFields}>
                  {guidedFields.map((field) => {
                    const value = argumentValues?.[field.name];
                    return (
                      <View key={field.name} style={styles.guidedField}>
                        {field.kind === "string" ? (
                          <>
                            <Text style={styles.label}>
                              {field.name}
                              {field.required ? " *" : ""}
                            </Text>
                            {field.description ? (
                              <Text style={styles.secondary}>{field.description}</Text>
                            ) : null}
                            <TextInput
                              accessibilityLabel={field.name}
                              accessibilityState={{ disabled: !editable || invalidArguments }}
                              value={typeof value === "string" ? value : ""}
                              maxLength={2048}
                              editable={editable && !invalidArguments}
                              onChangeText={(text) => changeArgument(field.name, text)}
                              style={styles.input}
                            />
                            {value !== undefined ? (
                              <NativeActionButton
                                label={`${t("Remove")} ${field.name}`}
                                disabled={!editable || invalidArguments}
                                prominence="secondary"
                                onPress={() => changeArgument(field.name, undefined)}
                              />
                            ) : null}
                          </>
                        ) : (
                          <>
                            {field.description ? (
                              <Text style={styles.secondary}>{field.description}</Text>
                            ) : null}
                            <MenuPicker
                              label={`${field.name}${field.required ? " *" : ""}`}
                              disabled={!editable || invalidArguments}
                              value={
                                field.kind === "boolean"
                                  ? typeof value === "boolean"
                                    ? String(value)
                                    : ""
                                  : typeof value === "string"
                                    ? String(field.choices.indexOf(value) + 1)
                                    : ""
                              }
                              choices={[
                                { key: "", label: t("Not set") },
                                ...(field.kind === "boolean"
                                  ? [
                                      { key: "true", label: "true" },
                                      { key: "false", label: "false" },
                                    ]
                                  : field.choices.map((choice, index) => ({
                                      key: String(index + 1),
                                      label: choice || '""',
                                    }))),
                              ]}
                              onChange={(selected) =>
                                changeArgument(
                                  field.name,
                                  !selected
                                    ? undefined
                                    : field.kind === "boolean"
                                      ? selected === "true"
                                      : field.choices[Number(selected) - 1],
                                )
                              }
                            />
                          </>
                        )}
                      </View>
                    );
                  })}
                </View>
              ) : null}
              <Text style={styles.label}>{t("Operation arguments (JSON object)")}</Text>
              <Text style={styles.secondary}>
                {t(
                  "Use the integration settings for API keys and passwords. Pagination tokens can be entered here. Arguments are not validated against the operation schema here.",
                )}
              </Text>
              <TextInput
                accessibilityLabel={t("Operation arguments (JSON object)")}
                value={argumentText}
                onChangeText={(value) => {
                  setArgumentText(value);
                  clearCheck();
                }}
                editable={editable}
                maxLength={8192}
                multiline
                style={styles.input}
                placeholder="{}"
              />
              {argumentFields &&
              typeof argumentFields === "object" &&
              !Array.isArray(argumentFields) ? (
                <Text style={styles.secondary}>
                  {t("Declared fields:")}{" "}
                  {Object.keys(argumentFields).slice(0, 20).join(", ") || "—"}
                </Text>
              ) : null}
              {requiredFields.length ? (
                <Text style={styles.secondary}>
                  {t("Declared required fields:")} {requiredFields.join(", ")}
                </Text>
              ) : null}
            </View>
          ) : null}
          {catalog?.status === "ok" && !catalog.tools.length ? (
            <Text style={styles.secondary}>{t("No declared read operations were found.")}</Text>
          ) : null}
          <Text style={styles.label}>
            {t("When should it check?")} {timezone}
          </Text>
          <View>
            <MenuPicker
              disabled={!editable}
              label={t("How often")}
              value={frequency}
              choices={[
                { key: "hourly", label: t("Every hour") },
                { key: "daily", label: t("Every day") },
                { key: "weekdays", label: t("Weekdays") },
                ...(frequency === "custom" ? [{ key: "custom", label: t("Custom schedule") }] : []),
              ]}
              onChange={(value) => {
                setFrequency(value as Frequency);
                clearCheck();
              }}
            />
            {frequency === "daily" || frequency === "weekdays" ? (
              <DateTimePicker
                value={time}
                mode="time"
                presentation="inline"
                disabled={!editable}
                style={styles.picker}
                onValueChange={(_, value) => {
                  setTime(value);
                  clearCheck();
                }}
              />
            ) : null}
            {frequency === "custom" ? (
              <Text style={styles.secondary}>
                {t("Custom schedule is preserved. Choose another frequency to replace it.")}
              </Text>
            ) : null}
          </View>
          <NativeActionButton
            label={t("Save draft")}
            disabled={!editable || !dirty}
            onPress={() => void perform(save)}
          />
          <NativeActionButton
            label={t("Manage integrations")}
            disabled={busy}
            prominence="secondary"
            onPress={openIntegrations}
          />
          <NativeActionButton
            label={t("Refresh integrations")}
            disabled={busy || !session}
            prominence="secondary"
            onPress={() => void perform(() => refresh())}
          />

          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {busy ? (
            <Text accessibilityLiveRegion="polite" style={styles.secondary}>
              {t("Working…")}
            </Text>
          ) : null}
          {plan ? (
            <View style={styles.review}>
              <Text accessibilityRole="header" style={styles.label}>
                {plan.status === "draft"
                  ? t("Draft saved")
                  : plan.status === "configured"
                    ? plan.routineId
                      ? routineActive === true
                        ? t("Active")
                        : routineActive === false
                          ? t("Paused")
                          : t("Configured")
                      : t("Routine no longer exists")
                    : t("Proposal saved")}
              </Text>
              {dirty ? (
                <Text style={styles.secondary}>
                  {t("Save changes before checking this proposal.")}
                </Text>
              ) : null}
              <NativeActionButton
                label={t("Check setup")}
                disabled={busy || dirty}
                prominence="secondary"
                onPress={() => void perform(check)}
              />
              {prerequisites ? (
                <View accessibilityLiveRegion="polite" style={styles.readiness}>
                  <Text style={styles.secondary}>
                    {t("Bot:")}{" "}
                    {prerequisites.bot === "available" ? t("Available") : t("Unavailable")}
                  </Text>
                  <Text style={styles.secondary}>
                    {t("Integration:")}{" "}
                    {prerequisites.source === "available"
                      ? t("Available")
                      : prerequisites.source === "changed"
                        ? t("Changed; choose it again")
                        : t("Unavailable")}
                  </Text>
                  <Text style={styles.secondary}>
                    {t("Assignment:")}{" "}
                    {prerequisites.assignment === "configured"
                      ? t("Configured")
                      : prerequisites.assignment === "not_configured"
                        ? t("Not configured")
                        : t("Not checked")}
                  </Text>
                  <Text style={styles.secondary}>
                    {t("Selected operation permission:")}{" "}
                    {prerequisites.selectedTool === "allowed"
                      ? t("Allowed in bot settings")
                      : prerequisites.selectedTool === "blocked"
                        ? t("Not allowed in bot settings")
                        : t("Not checked")}
                  </Text>
                  {candidates ? (
                    <Text style={styles.secondary}>
                      {t("Operation:")}{" "}
                      {candidates.selectedOperation === "declared_read"
                        ? t("Declared as read-only")
                        : candidates.selectedOperation === "not_found"
                          ? t("Not found")
                          : t("Not checked")}
                    </Text>
                  ) : null}
                  <Text style={styles.secondary}>
                    {t(
                      "Source access and permissions have not been verified. No read was performed.",
                    )}
                  </Text>
                </View>
              ) : null}
              {plan.status === "draft" ? (
                <NativeActionButton
                  label={t("Save proposal")}
                  disabled={busy || !canPropose}
                  prominence="secondary"
                  onPress={() => void perform(propose)}
                />
              ) : null}
              {plan.status === "proposed" ? (
                <>
                  <Text style={styles.secondary}>
                    {t("This creates a paused routine that you can test and activate.")}
                  </Text>
                  <NativeActionButton
                    label={t("Create paused routine")}
                    disabled={busy || !canPropose}
                    onPress={() => void perform(configure)}
                  />
                </>
              ) : null}
              {plan.status === "configured" ? (
                <View style={styles.readiness}>
                  <Text style={styles.secondary}>
                    {t(
                      "When setup matches the routine, a source check attempts the selected operation with these arguments. Run status shows whether it succeeded. A test does not confirm notification delivery.",
                    )}
                  </Text>
                  {plan.routineId ? (
                    <>
                      <Text style={styles.secondary}>
                        {t("A test may read the selected source and send a notification.")}
                      </Text>
                      <NativeActionButton
                        label={t("Run test")}
                        disabled={busy}
                        onPress={() => void perform(runTest)}
                      />
                      {routineActive !== null ? (
                        <NativeActionButton
                          label={routineActive ? t("Pause routine") : t("Activate routine")}
                          disabled={busy}
                          prominence="secondary"
                          onPress={() => void perform(() => setActive(!routineActive))}
                        />
                      ) : routineStateError ? (
                        <Text style={styles.secondary}>
                          {t("Could not load routine status. Open Routines to activate it.")}
                        </Text>
                      ) : null}
                      {testRunId ? (
                        <View accessibilityLiveRegion="polite" style={styles.readiness}>
                          {restoredTest ? (
                            <Text style={styles.secondary}>
                              {t(
                                "Most recent source test for this routine. It reflects the setup when that test ran.",
                              )}
                            </Text>
                          ) : null}
                          <Text style={styles.secondary}>
                            {t("Run status:")} {testStatus}
                          </Text>
                          {sourceTestStatus === "failed" ? (
                            <Text style={styles.secondary}>
                              {t(
                                "If the integration changed, choose New proposal and set it up again.",
                              )}
                            </Text>
                          ) : null}
                          <Text style={styles.secondary}>
                            {t("Source test:")}{" "}
                            {sourceTestStatus === "not_started"
                              ? t("Not started")
                              : sourceTestStatus === "pending"
                                ? t("Pending")
                                : sourceTestStatus === "running"
                                  ? t("Running")
                                  : sourceTestStatus === "succeeded"
                                    ? t("Succeeded")
                                    : sourceTestStatus === "failed"
                                      ? t("Failed")
                                      : sourceTestStatus === "uncertain"
                                        ? t("Uncertain")
                                        : sourceTestStatus === "unbound"
                                          ? t("Setup changed; source not verified")
                                          : sourceTestStatus === "unavailable"
                                            ? t("Unavailable for this run")
                                            : t("Not checked")}
                          </Text>
                          <Text style={styles.secondary}>
                            {t("Open routine history for the result and notification status.")}
                          </Text>
                          <NativeActionButton
                            label={t("Refresh status")}
                            disabled={busy}
                            prominence="secondary"
                            onPress={() => void perform(refreshTest)}
                          />
                        </View>
                      ) : null}
                    </>
                  ) : (
                    <Text style={styles.secondary}>
                      {t("The routine is unavailable, so a test cannot run.")}
                    </Text>
                  )}
                </View>
              ) : null}
            </View>
          ) : null}
          <NativeActionButton
            label={t("Close")}
            disabled={busy}
            prominence="secondary"
            onPress={close}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { flexGrow: 1, padding: 20, gap: 12 },
    title: { fontSize: 20, fontWeight: "600", color: native.label },
    label: { fontSize: 16, fontWeight: "500", color: native.label },
    secondary: { fontSize: 14, color: native.secondaryLabel },
    input: {
      minHeight: 88,
      color: native.label,
      backgroundColor: native.groupedCell,
      padding: 12,
      borderRadius: 10,
      fontSize: 16,
    },
    picker: { width: "100%", minHeight: 44 },
    guidedFields: { gap: 12, marginBottom: 12 },
    guidedField: { gap: 6 },
    review: {
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.separator,
      paddingTop: 16,
    },
    readiness: { gap: 4 },
    error: { fontSize: 14, color: native.label },
  });
}
