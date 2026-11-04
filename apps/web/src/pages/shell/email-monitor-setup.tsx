import { Trans, useLingui } from "@lingui/react/macro";
import { type McpServer, type RoutineRun, SetupOperationArgumentsSchema } from "@rakazo/contracts";
import type { CronPreset } from "@rakazo/core";
import { cronFromPreset, defaultCronPreset, presetFromCron } from "@rakazo/core";
import { Button, NativeSelect, NativeSelectOption, Textarea } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { localTimezone } from "../../lib/local-timezone";
import type { createSpaceRpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { RoutineSchedule } from "../RoutineSchedule";

type Client = ReturnType<typeof createSpaceRpc>;
type Plan = Awaited<ReturnType<Client["setupPlans"]["get"]>>;
type Draft = Plan["draft"];
type Prerequisites = Awaited<ReturnType<Client["setupPlans"]["prerequisites"]>>;
type Candidates = Awaited<ReturnType<Client["setupPlans"]["discoverCandidates"]>>;
type Catalog = Awaited<ReturnType<Client["mcp"]["servers"]["monitorTools"]>>;
type SourceTestStatus =
  | NonNullable<RoutineRun["sourceTest"]>
  | "not_checked"
  | "unavailable"
  | "unbound";
function testKey(owner: string, space: string, plan: Plan): { storageKey: string; key: string } {
  const storageKey = `rakazo:monitor-test:${JSON.stringify([owner, space, plan.id, plan.revision])}`;
  const saved = window.localStorage.getItem(storageKey);
  if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved))
    return { storageKey, key: saved };
  if (saved) throw new Error("Could not safely recover the previous test request.");
  const key = crypto.randomUUID();
  window.localStorage.setItem(storageKey, key);
  return { storageKey, key };
}

function pendingCreateKey(botId: string): string {
  const storageKey = `rakazo:email-monitor-create:${botId}`;
  try {
    const saved = window.sessionStorage.getItem(storageKey);
    if (saved) return saved;
    const key = crypto.randomUUID();
    window.sessionStorage.setItem(storageKey, key);
    return key;
  } catch {
    return crypto.randomUUID();
  }
}

function clearPendingCreateKey(botId: string, key: string) {
  try {
    const storageKey = `rakazo:email-monitor-create:${botId}`;
    if (window.sessionStorage.getItem(storageKey) === key)
      window.sessionStorage.removeItem(storageKey);
  } catch {
    // The proposal was saved; unavailable browser storage does not change that result.
  }
}

/** A saved proposal is not a routine, a test, or a verified connection. */
export function EmailMonitorSetup({
  botId,
  botName,
  rpc,
  onOpenIntegrations,
  onConfigured,
}: {
  botId: string;
  botName: string;
  rpc: Client;
  onOpenIntegrations: () => void;
  onConfigured?: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const createAttempt = useRef<{ key: string; payload: string } | null>(null);
  const configureAttempt = useRef<{ id: string; revision: number; key: string } | null>(null);
  const testReadGeneration = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [purpose, setPurpose] = useState("");
  const [serverId, setServerId] = useState("");
  const [sourceRevision, setSourceRevision] = useState<number | null>(null);
  const [toolName, setToolName] = useState("");
  const [argumentText, setArgumentText] = useState("");
  const [schedule, setSchedule] = useState<CronPreset>(() => defaultCronPreset());
  const [timezone, setTimezone] = useState(() => localTimezone());
  const [notify, setNotify] = useState(true);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
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
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setRoutineActive(null);
    setRoutineStateError(false);
    if (plan?.status === "configured" && plan.routineId) {
      void rpc.routines.list({ botId }).then(
        (routines) => {
          if (!current) return;
          const routine = routines.find((item) => item.id === plan.routineId);
          if (routine) setRoutineActive(routine.active);
          else setRoutineStateError(true);
        },
        () => {
          if (current) setRoutineStateError(true);
        },
      );
    }
    return () => {
      current = false;
    };
  }, [rpc, botId, plan?.id, plan?.routineId, plan?.status]);

  useEffect(() => {
    const generation = ++testReadGeneration.current;
    if (plan?.status === "configured" && plan.routineId) {
      void rpc.routines.history({ routineId: plan.routineId, limit: 20 }).then(
        (history) => {
          if (!mounted.current || testReadGeneration.current !== generation) return;
          const latest = history.runs.find((run) => run.sourceTest !== undefined);
          if (!latest) return;
          setTestRunId(latest.id);
          setTestStatus(latest.status);
          setSourceTestStatus(latest.sourceUnbound ? "unbound" : latest.sourceTest!);
          setRestoredTest(true);
        },
        () => undefined,
      );
    }
    return () => {
      if (testReadGeneration.current === generation) testReadGeneration.current += 1;
    };
  }, [rpc, botId, plan?.id, plan?.revision, plan?.routineId, plan?.status, planSelection]);

  function clearCheck() {
    setPrerequisites(null);
    setCandidates(null);
    setError(null);
  }

  function loadPlan(next: Plan) {
    testReadGeneration.current += 1;
    setPlanSelection((value) => value + 1);
    setPlan(next);
    setTestRunId(null);
    setTestStatus(null);
    setSourceTestStatus("not_checked");
    setRestoredTest(false);
    setPurpose(next.draft.purpose);
    setServerId(next.draft.source?.serverId ?? "");
    setSourceRevision(next.draft.source?.revision ?? null);
    setToolName(next.draft.source?.toolName ?? "");
    setArgumentText(
      next.draft.arguments === undefined ? "" : JSON.stringify(next.draft.arguments, null, 2),
    );
    setSchedule(
      next.draft.schedule ? presetFromCron(next.draft.schedule.cron) : defaultCronPreset(),
    );
    setTimezone(next.draft.schedule?.timezone ?? localTimezone());
    setNotify(next.draft.notify);
    setCatalog(null);
    createAttempt.current = null;
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
    setSchedule(defaultCronPreset());
    setTimezone(localTimezone());
    setNotify(true);
    setCatalog(null);
    createAttempt.current = null;
    clearCheck();
  }

  async function perform(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      if (mounted.current) setError(errorText(cause, t`Could not update the setup. Try again.`));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function load() {
    const [integrations, result] = await Promise.all([
      rpc.mcp.servers.list(),
      rpc.setupPlans.list({ limit: 100 }),
    ]);
    if (!mounted.current) return;
    setServers(integrations.filter((server) => server.enabled));
    setPlans(result.plans.filter((item) => item.draft.botId === botId));
    setCursor(result.nextCursor);
  }

  async function loadMore() {
    if (!cursor) return;
    const result = await rpc.setupPlans.list({ limit: 100, cursor });
    if (!mounted.current) return;
    setPlans((current) => [
      ...current,
      ...result.plans.filter((item) => item.draft.botId === botId),
    ]);
    setCursor(result.nextCursor);
  }

  let parsedArguments: Draft["arguments"];
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
  const argumentSchema = catalog?.tools.find((tool) => tool.name === toolName)?.inputSchema;
  const argumentFields = argumentSchema?.properties;
  const requiredFields = Array.isArray(argumentSchema?.required)
    ? argumentSchema.required
        .filter((field): field is string => typeof field === "string")
        .slice(0, 20)
    : [];
  const draft: Draft = {
    kind: "email_monitor",
    purpose: purpose.trim(),
    ...(parsedArguments === undefined ? {} : { arguments: parsedArguments }),
    botId,
    source:
      serverId && sourceRevision && toolName
        ? { serverId, revision: sourceRevision, toolName }
        : null,
    schedule: { cron: cronFromPreset(schedule), timezone },
    notify,
  };
  const dirty = invalidArguments || !plan || JSON.stringify(draft) !== JSON.stringify(plan.draft);
  const currentCheck =
    !dirty &&
    prerequisites?.planRevision === plan?.revision &&
    candidates?.planRevision === plan?.revision;
  const readyToPropose =
    currentCheck &&
    prerequisites?.bot === "available" &&
    prerequisites.source === "available" &&
    prerequisites.assignment === "configured" &&
    prerequisites.selectedTool === "allowed" &&
    candidates?.status === "ok" &&
    candidates.selectedOperation === "declared_read";

  async function findOperations() {
    if (!serverId) return;
    const found = await rpc.mcp.servers.monitorTools({ id: serverId, botId });
    if (!mounted.current) return;
    setCatalog(found);
    setSourceRevision(found.revision);
    setToolName("");
    setArgumentText("");
    clearCheck();
  }

  async function saveDraft() {
    if (invalidArguments) {
      setError(t`Enter a valid JSON object up to 8 KB.`);
      return;
    }
    if (!draft.purpose) {
      setError(t`Describe what the agent should watch.`);
      return;
    }
    if (!draft.source) {
      setError(t`Choose an integration and a read operation.`);
      return;
    }
    const payload = JSON.stringify(draft);
    if (!plan && createAttempt.current && createAttempt.current.payload !== payload) {
      setError(
        t`The previous save may have completed. Retry the same draft or reopen it from saved drafts.`,
      );
      return;
    }
    if (!plan && !createAttempt.current)
      createAttempt.current = { key: pendingCreateKey(botId), payload };
    const saved = plan
      ? await rpc.setupPlans.update({ id: plan.id, expectedRevision: plan.revision, draft })
      : await rpc.setupPlans.create({
          requestKey: createAttempt.current!.key,
          draft,
        });
    if (!plan && createAttempt.current) clearPendingCreateKey(botId, createAttempt.current.key);
    if (!mounted.current) return;
    createAttempt.current = null;
    setPlan(saved);
    setPlans((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    clearCheck();
  }

  async function checkDraft() {
    if (!plan || dirty) return;
    const next = await rpc.setupPlans.prerequisites({
      id: plan.id,
      expectedRevision: plan.revision,
    });
    if (!mounted.current) return;
    setPrerequisites(next);
    setCandidates(null);
    if (
      next.bot !== "available" ||
      next.source !== "available" ||
      next.assignment !== "configured" ||
      next.selectedTool !== "allowed"
    )
      return;
    const found = await rpc.setupPlans.discoverCandidates({
      id: plan.id,
      expectedRevision: plan.revision,
    });
    if (mounted.current) setCandidates(found);
  }

  async function propose() {
    if (!plan || !readyToPropose) return;
    const proposed = await rpc.setupPlans.propose({ id: plan.id, expectedRevision: plan.revision });
    if (!mounted.current) return;
    setPlan(proposed);
    setPlans((current) => current.map((item) => (item.id === proposed.id ? proposed : item)));
    clearCheck();
  }

  async function configure() {
    if (plan?.status !== "proposed" || !readyToPropose) return;
    if (
      configureAttempt.current?.id !== plan.id ||
      configureAttempt.current.revision !== plan.revision
    ) {
      configureAttempt.current = { id: plan.id, revision: plan.revision, key: crypto.randomUUID() };
    }
    const configured = await rpc.setupPlans.configure({
      id: plan.id,
      expectedRevision: plan.revision,
      requestKey: configureAttempt.current.key,
    });
    if (!mounted.current) return;
    setPlan(configured);
    setPlans((current) => current.map((item) => (item.id === configured.id ? configured : item)));
    configureAttempt.current = null;
    clearCheck();
    onConfigured?.();
  }

  async function runTest() {
    if (plan?.status !== "configured" || !plan.routineId) return;
    const generation = ++testReadGeneration.current;
    const me = await rpc.me();
    if (!mounted.current || testReadGeneration.current !== generation) return;
    const { storageKey, key } = testKey(me.userId, me.spaceId, plan);
    const result = await rpc.routines.testRun({ routineId: plan.routineId, clientNonce: key });
    try {
      if (window.localStorage.getItem(storageKey) === key)
        window.localStorage.removeItem(storageKey);
    } catch {
      /* The confirmed run remains available in routine history. */
    }
    if (mounted.current && testReadGeneration.current === generation) {
      setTestRunId(result.runId);
      setTestStatus("not checked");
      setSourceTestStatus("not_checked");
      setRestoredTest(false);
    }
  }

  async function refreshTest() {
    if (!plan?.routineId || !testRunId) return;
    const generation = ++testReadGeneration.current;
    const history = await rpc.routines.history({ routineId: plan.routineId, limit: 20 });
    const run = history.runs.find((item) => item.id === testRunId);
    if (mounted.current && testReadGeneration.current === generation) {
      setTestStatus(run?.status ?? "unknown");
      setSourceTestStatus(run?.sourceUnbound ? "unbound" : (run?.sourceTest ?? "unavailable"));
    }
  }

  async function setActive(active: boolean) {
    if (!plan?.routineId) return;
    const updated = await rpc.routines.update({ routineId: plan.routineId, active });
    if (mounted.current) {
      setRoutineActive(updated.active);
      onConfigured?.();
    }
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        className="mb-3 min-h-11 w-full"
        onClick={() => {
          setOpen(true);
          void perform(load);
        }}
      >
        <Trans>Set up email monitor</Trans>
      </Button>
    );
  }

  return (
    <section className="mb-5 min-w-0 border-b border-border pb-5" aria-labelledby={`${id}-title`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={`${id}-title`} className="text-base font-medium">
            <Trans>Email monitor</Trans>
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{botName}</p>
        </div>
        <Button variant="ghost" className="min-h-11" disabled={busy} onClick={() => setOpen(false)}>
          <Trans>Close</Trans>
        </Button>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {plan?.status === "configured" ? (
          <Trans>This setup is saved. Its routine status and available actions appear below.</Trans>
        ) : (
          <Trans>This saves a proposal. It does not start a routine or check your mailbox.</Trans>
        )}
      </p>

      {plans.length ? (
        <div className="mt-4">
          <h4 className="text-sm font-medium">
            <Trans>Saved proposals</Trans>
          </h4>
          <ul className="mt-1 divide-y divide-border">
            {plans.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="min-h-11 w-full py-2 text-start text-sm"
                  disabled={busy}
                  onClick={() => loadPlan(item)}
                >
                  <span className="block break-words">{item.draft.purpose}</span>
                  <span className="text-muted-foreground">
                    {item.status === "draft"
                      ? t`Draft`
                      : item.status === "configured"
                        ? t`Configured`
                        : t`Proposed`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {plan ? (
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={busy || dirty}
              onClick={newProposal}
            >
              <Trans>New proposal</Trans>
            </Button>
          ) : null}
          {cursor ? (
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              onClick={() => void perform(loadMore)}
            >
              <Trans>Load more</Trans>
            </Button>
          ) : null}
        </div>
      ) : cursor ? (
        <Button
          variant="ghost"
          className="mt-3 min-h-11"
          disabled={busy}
          onClick={() => void perform(loadMore)}
        >
          <Trans>Load more proposals</Trans>
        </Button>
      ) : null}

      <fieldset disabled={busy || plan?.status === "configured"} className="mt-4 min-w-0 space-y-4">
        <label htmlFor={`${id}-purpose`} className="block text-sm">
          <Trans>What should {botName} watch for?</Trans>
          <Textarea
            id={`${id}-purpose`}
            value={purpose}
            maxLength={2000}
            rows={3}
            className="mt-2"
            onChange={(event) => {
              setPurpose(event.target.value);
              clearCheck();
            }}
          />
        </label>
        <div className="text-sm">
          <label htmlFor={`${id}-server`}>
            <Trans>Integration</Trans>
          </label>
          <NativeSelect
            id={`${id}-server`}
            aria-label={t`Integration`}
            value={serverId}
            className="mt-2 w-full [&>select]:h-11"
            onChange={(event) => {
              const next = event.target.value;
              setServerId(next);
              setSourceRevision(servers.find((server) => server.id === next)?.revision ?? null);
              setToolName("");
              setArgumentText("");
              setCatalog(null);
              clearCheck();
            }}
          >
            <NativeSelectOption value="">{t`Choose an integration`}</NativeSelectOption>
            {serverId && !servers.some((server) => server.id === serverId) ? (
              <NativeSelectOption value={serverId}>{t`Unavailable integration`}</NativeSelectOption>
            ) : null}
            {servers.map((server) => (
              <NativeSelectOption key={server.id} value={server.id}>
                {server.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={!serverId}
            onClick={() => void perform(findOperations)}
          >
            <Trans>Find read operations</Trans>
          </Button>
        </div>
        {catalog?.status === "not_assigned" ? (
          <p role="status" className="text-sm text-warning">
            <Trans>Assign this integration to the bot first.</Trans>
          </p>
        ) : null}
        {catalog?.status === "unavailable" ? (
          <p role="status" className="text-sm text-warning">
            <Trans>This integration is unavailable.</Trans>
          </p>
        ) : null}
        {catalog?.status === "ok" ? (
          <div className="text-sm">
            <label htmlFor={`${id}-tool`}>
              <Trans>Read operation</Trans>
            </label>
            <NativeSelect
              id={`${id}-tool`}
              aria-label={t`Read operation`}
              value={toolName}
              className="mt-2 w-full [&>select]:h-11"
              onChange={(event) => {
                setToolName(event.target.value);
                setArgumentText("");
                clearCheck();
              }}
            >
              <NativeSelectOption value="">{t`Choose an operation`}</NativeSelectOption>
              {catalog.tools.map((tool) => (
                <NativeSelectOption key={tool.name} value={tool.name}>
                  {tool.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {catalog.tools.length === 0 ? (
              <span className="mt-2 block text-muted-foreground">
                <Trans>No declared read operations were found.</Trans>
              </span>
            ) : null}
          </div>
        ) : toolName ? (
          <p className="text-sm">
            <Trans>Read operation:</Trans> {toolName}
          </p>
        ) : null}
        {toolName ? (
          <div className="text-sm">
            <label htmlFor={`${id}-arguments`}>
              <Trans>Operation arguments (JSON object)</Trans>
            </label>
            <p className="mt-1 text-muted-foreground">
              <Trans>
                Use the integration settings for API keys and passwords. Pagination tokens can be
                entered here. Arguments are not validated against the operation schema here.
              </Trans>
            </p>
            <Textarea
              id={`${id}-arguments`}
              value={argumentText}
              maxLength={8192}
              onChange={(event) => {
                setArgumentText(event.target.value);
                clearCheck();
              }}
              className="mt-2 w-full"
              placeholder="{}"
            />
            {argumentFields &&
            typeof argumentFields === "object" &&
            !Array.isArray(argumentFields) ? (
              <p className="mt-1 text-muted-foreground">
                <Trans>Declared fields:</Trans>{" "}
                {Object.keys(argumentFields).slice(0, 20).join(", ") || "—"}
              </p>
            ) : null}
            {requiredFields.length ? (
              <p className="mt-1 text-muted-foreground">
                <Trans>Declared required fields:</Trans> {requiredFields.join(", ")}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="text-sm [&_input]:h-11 [&_select[data-size=sm]]:h-11">
          <p>
            <Trans>When should it check?</Trans>{" "}
            <span className="text-muted-foreground">{timezone}</span>
          </p>
          <RoutineSchedule
            value={schedule}
            onChange={(next) => {
              setSchedule(next);
              clearCheck();
            }}
          />
        </div>
        <Button className="min-h-11" disabled={!dirty} onClick={() => void perform(saveDraft)}>
          <Trans>Save draft</Trans>
        </Button>
      </fieldset>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="ghost" className="min-h-11" disabled={busy} onClick={onOpenIntegrations}>
          <Trans>Manage integrations</Trans>
        </Button>
        <Button
          variant="ghost"
          className="min-h-11"
          disabled={busy}
          onClick={() => void perform(load)}
        >
          <Trans>Refresh integrations</Trans>
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          <Trans>Working…</Trans>
        </p>
      ) : null}
      {plan ? (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <p className="text-sm font-medium">
            {plan.status === "draft"
              ? t`Draft saved`
              : plan.status === "configured"
                ? plan.routineId
                  ? routineActive === true
                    ? t`Active`
                    : routineActive === false
                      ? t`Paused`
                      : t`Configured`
                  : t`Routine no longer exists`
                : t`Proposal saved`}
          </p>
          {plan.status === "configured" ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <Trans>
                  When setup matches the routine, a source check attempts the selected operation
                  with these arguments. Run status shows whether it succeeded. A test does not
                  confirm notification delivery.
                </Trans>
              </p>
              {plan.routineId ? (
                <>
                  <p>
                    <Trans>A test may read the selected source and send a notification.</Trans>
                  </p>
                  <Button
                    className="min-h-11"
                    disabled={busy}
                    onClick={() => void perform(runTest)}
                  >
                    <Trans>Run test</Trans>
                  </Button>
                  {routineActive !== null ? (
                    <Button
                      variant="secondary"
                      className="min-h-11"
                      disabled={busy}
                      onClick={() => void perform(() => setActive(!routineActive))}
                    >
                      {routineActive ? (
                        <Trans>Pause routine</Trans>
                      ) : (
                        <Trans>Activate routine</Trans>
                      )}
                    </Button>
                  ) : routineStateError ? (
                    <p role="status">
                      <Trans>Could not load routine status. Open Routines to activate it.</Trans>
                    </p>
                  ) : null}
                  {testRunId ? (
                    <div role="status" className="space-y-2">
                      {restoredTest ? (
                        <p>
                          <Trans>
                            Most recent source test for this routine. It reflects the setup when
                            that test ran.
                          </Trans>
                        </p>
                      ) : null}
                      <p>
                        <Trans>Run status:</Trans> {testStatus}
                      </p>
                      <p>
                        <Trans>Source test:</Trans>{" "}
                        {sourceTestStatus === "not_started" ? (
                          <Trans>Not started</Trans>
                        ) : sourceTestStatus === "pending" ? (
                          <Trans>Pending</Trans>
                        ) : sourceTestStatus === "running" ? (
                          <Trans>Running</Trans>
                        ) : sourceTestStatus === "succeeded" ? (
                          <Trans>Succeeded</Trans>
                        ) : sourceTestStatus === "failed" ? (
                          <Trans>Failed</Trans>
                        ) : sourceTestStatus === "uncertain" ? (
                          <Trans>Uncertain</Trans>
                        ) : sourceTestStatus === "unbound" ? (
                          <Trans>Setup changed; source not verified</Trans>
                        ) : sourceTestStatus === "unavailable" ? (
                          <Trans>Unavailable for this run</Trans>
                        ) : (
                          <Trans>Not checked</Trans>
                        )}
                      </p>
                      {sourceTestStatus === "failed" ? (
                        <p>
                          <Trans>
                            If the integration changed, choose New proposal and set it up again.
                          </Trans>
                        </p>
                      ) : null}
                      <p>
                        <Trans>Open routine history for the result and notification status.</Trans>
                      </p>
                      <Button
                        variant="secondary"
                        className="min-h-11"
                        disabled={busy}
                        onClick={() => void perform(refreshTest)}
                      >
                        <Trans>Refresh status</Trans>
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p>
                  <Trans>The routine is unavailable, so a test cannot run.</Trans>
                </p>
              )}
            </div>
          ) : null}
          {dirty ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Save changes before checking this proposal.</Trans>
            </p>
          ) : null}
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={busy || dirty}
            onClick={() => void perform(checkDraft)}
          >
            <Trans>Check setup</Trans>
          </Button>
          {prerequisites ? (
            <div role="status" className="space-y-1 text-sm text-muted-foreground">
              <p>
                <Trans>Bot:</Trans>{" "}
                {prerequisites.bot === "available" ? t`Available` : t`Unavailable`}
              </p>
              <p>
                <Trans>Integration:</Trans>{" "}
                {prerequisites.source === "available"
                  ? t`Available`
                  : prerequisites.source === "changed"
                    ? t`Changed; choose it again`
                    : t`Unavailable`}
              </p>
              <p>
                <Trans>Assignment:</Trans>{" "}
                {prerequisites.assignment === "configured"
                  ? t`Configured`
                  : prerequisites.assignment === "not_configured"
                    ? t`Not configured`
                    : t`Not checked`}
              </p>
              <p>
                <Trans>Selected operation permission:</Trans>{" "}
                {prerequisites.selectedTool === "allowed"
                  ? t`Allowed in bot settings`
                  : prerequisites.selectedTool === "blocked"
                    ? t`Not allowed in bot settings`
                    : t`Not checked`}
              </p>
              {candidates ? (
                <p>
                  <Trans>Operation:</Trans>{" "}
                  {candidates.selectedOperation === "declared_read"
                    ? t`Declared as read-only`
                    : candidates.selectedOperation === "not_found"
                      ? t`Not found`
                      : t`Not checked`}
                </p>
              ) : null}
              <p>
                <Trans>
                  Mailbox access and permissions have not been verified. No read was performed.
                </Trans>
              </p>
            </div>
          ) : null}
          {plan.status === "draft" ? (
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy || !readyToPropose}
              onClick={() => void perform(propose)}
            >
              <Trans>Save proposal</Trans>
            </Button>
          ) : null}
          {plan.status === "proposed" ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                <Trans>This creates a paused routine that you can test and activate.</Trans>
              </p>
              <Button
                className="min-h-11"
                disabled={busy || !readyToPropose}
                onClick={() => void perform(configure)}
              >
                <Trans>Create paused routine</Trans>
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
