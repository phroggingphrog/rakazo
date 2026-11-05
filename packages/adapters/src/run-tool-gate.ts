import { isDeepStrictEqual } from "node:util";
import type {
  AdapterContext,
  AgentToolExecutionObserver,
  AutoReviewRequest,
  ConnectorCall,
  ToolBatch,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import {
  applyJudgeDecision,
  approvalModeFromPreference,
  batchActions,
  connectorKindFromToolName,
  connectorReadRequiresApproval,
  connectorToolRequiresApproval,
  decisiveActionApprovalRules,
  displayName,
  humanizeToolName,
  newSiteOutcome,
  outboundSiteGate,
  planActionGate,
  redactSecrets,
  repeatsDeniedAction,
  resolveActionApprovalForTools,
  toolRequiresApproval,
  toolRequiresExplicitApproval,
  unattendedTriggerToolRequiresApproval,
} from "@rakazo/core";
import { normalizedHttpUrl, urlSite } from "@rakazo/core/egress";
import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { AuditEventInput, Prisma } from "@rakazo/db";
import { recordAuditEvent, runSecretKind } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { FleetCardSummary } from "./approval-ask.js";
import { buildApprovalAskBlock, MAX_FETCH_URL_LENGTH, SITE_SENDING_TOOLS } from "./approval-ask.js";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  catalogApprovalRequest,
  DENIED_ACTION_ERROR,
  resolveDuplicateEffectGate,
  uncertainEffectResult,
} from "./approval-effect.js";
import type { AutoReviewChecker } from "./auto-review.js";
import {
  isAutoReviewCheckerConfigured,
  redactToolArgsForReview,
  resolveAutoReviewChecker,
} from "./auto-review.js";
import { reviewWithBackups } from "./auto-review-backups.js";
import { RAKAZO_DOCS_URLS } from "./builtin-skills.js";
import { installedMcpBinding, lockInstalledMcpBinding, sameInstalledMcpBinding } from "./installed-mcp-binding.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { claimMcpEffect, finishMcpEffect, finishPipedreamEffect, PipedreamBindingChangedError, PipedreamBindingUncertainError } from "./mcp-effect-claim.js";
import type { PreparedPipedreamBinding } from "./pipedream-binding.js";
import { recheckPipedreamEffect } from "./pipedream-binding.js";
import { findConnectedModelCredential } from "./model-selection.js";
import { paidRequestEffect } from "./paid-request.js";
import { autoReviewCheckerProvider } from "./run-auto-review.js";
import type { RunContext, RunTrust } from "./run-context.js";
import {
  isRunTainted,
  nextMutatingEffectOccurrence,
  pauseForApproval,
  pauseForSecret,
  persistTurnCheckpoint,
} from "./run-context.js";
import {
  CATALOG_APPROVAL_TOOL,
  claimEffect,
  completeEffect,
  recordEffect,
  mcpEffectiveArgsFingerprint,
  settleInvalidScreenAction,
  settleLocalEffectRejection,
  settleRunEffectUncertainty,
  uncertainEffectError,
} from "./run-effects.js";
import { renewRunLease } from "./run-lifecycle.js";
import { evidenceForMonitorCall, persistMonitorReadEvidence } from "./run-monitor-evidence.js";
import { notifyRun } from "./run-notifications.js";
import { resolveCompletedSecretLeftover } from "./run-secret.js";
import type { ToolRequest } from "./run-tool-request.js";
import { BUILTIN_AGENT_TOOL_NAMES, READ_ONLY_AGENT_TOOLS } from "./run-tool-selection.js";
import { callMediaTool } from "./run-tools-files.js";
import { USER_COMPUTER_TOOLS, userComputerGate } from "./run-tools-user-computer.js";
import { connectorTrustKeys } from "./run-trust.js";
import { watchFromTool } from "./schedule-tools.js";
import { workspaceMonitorToolDecision } from "./workspace-monitoring.js";

export type AppliedEffect = Awaited<ReturnType<typeof recordEffect>>;

type ApprovalCard = {
  reviewReason: string | undefined;
  summary: FleetCardSummary | undefined;
  batch: ToolBatch | undefined;
};

/** A tool call that passed its approval gate, as tool handlers receive it. */
export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly executionId: string;
  readonly observer: AgentToolExecutionObserver | undefined;
  readonly connectorCall: ConnectorCall;
  /** This read is bound to a persisted monitor source. */
  readonly monitorSourceRecheck: boolean;
  /** Idempotency key of this call's effect; also the delivery key of what it sends. */
  readonly effectKey: string;
  /** The effect recorded for this call. Read-only tools that need no approval have none. */
  readonly applied: AppliedEffect | undefined;
  readonly nextApprovedTool: string | undefined;
  readonly pipedream?: PreparedPipedreamBinding;
  /** A gated call that policy or the reviewer allowed without asking. */
  readonly bypassApproval: boolean;
  /** This call moved its effect to executing. request_secret can hand the claim back. */
  claimedEffect: boolean;
  mcpClaimToken?: string;
  /** Store the result on the effect; false when it could not be stored. */
  readonly persistEffectResult: (result: unknown) => Promise<boolean>;
  /** Store the result and return it, or an uncertain-effect result when storing failed. */
  readonly finish: (result: unknown) => Promise<unknown>;
  /** A source-bound read was dispatched but its outcome could not be verified. */
  readonly finishMonitorUncertain: () => Promise<unknown>;
  readonly finishConnectorUncertain: () => Promise<unknown>;
  /** Use only for a trusted local rejection before any action was dispatched. */
  readonly finishInvalidScreenAction: (result: { error: string }) => Promise<unknown>;
  /** Record a local validation failure before attempting the shared-memory write. */
  readonly finishInvalidSharedMemory: (result: { error: string }) => Promise<unknown>;
  /** Record that no computer action was dispatched because the device was unavailable. */
  readonly finishComputerUnavailable: (result: { error: string }) => Promise<unknown>;
  /** A local stdio MCP registration was rejected before any server was created. */
  readonly finishStdioMcpForbidden: (result: { error: string }) => Promise<unknown>;
  /** An instruction-only transaction rejected its precondition before any update. */
  readonly finishInstructionPreconditionFailed: (result: { error: string }) => Promise<unknown>;
  /** Claim the effect to execute it, or return what an earlier attempt already settled. */
  readonly claimOrReturn: (from: "approved" | "intended") => Promise<unknown | undefined>;
}

export type ToolHandler = (ctx: RunContext, call: ToolCall) => Promise<unknown>;
export type ToolHandlers = Record<string, ToolHandler>;

type GateOutcome = { result: unknown } | { call: ToolCall };

type ToolReview = {
  name: string;
  args: Record<string, unknown>;
  connectorKind: ReturnType<typeof connectorKindFromToolName>;
  newSite: boolean;
  fetchUrl: string | undefined;
  matchingRules: ReturnType<typeof resolveActionApprovalForTools>["matchingRules"];
  gated: boolean;
  applied: AppliedEffect | undefined;
  injectedReview: ExecutorDeps["autoReview"];
  checker: AutoReviewChecker | null | undefined;
  reviewSettings: Awaited<ReturnType<RunTrust["loadApprovalModel"]>> | null;
  memberChecker: boolean;
};

/**
 * Decide whether a resolved call runs, asks the owner, is reviewed, or is refused, and record
 * the effect it claims. Returns the result to hand back when the call stops here.
 */
export async function gateToolCall(
  ctx: RunContext,
  request: ToolRequest,
  observer: AgentToolExecutionObserver | undefined,
): Promise<GateOutcome> {
  const { deps, run, runId, context } = ctx;
  const { name, executionId, connectorCall, resolvedTool, nextApprovedTool, approvedEffectKey } =
    request;
  const { replayEffectToolName } = request;
  let { args, effectRequest } = request;
  const viaConnector = !BUILTIN_AGENT_TOOL_NAMES.has(name);
  // Declared effect of the operation this call dispatches (installed API method and
  // flag). Install config is immutable per route resource, so it cannot drift before
  // execute; a catalog call uses the tool it was just resolved to.
  const connectorTool = viaConnector ? (resolvedTool ?? ctx.tools.connector.get(name)) : undefined;
  const declaredReadOnly = connectorTool?.readOnly;
  // A batch tool names the actions it runs in its arguments, so rules and the read/write
  // check look at each action, never the batch tool. An entry naming no action asks.
  const batch = connectorTool?.batch ? batchActions(connectorTool.batch, args) : undefined;
  const unidentifiedAction = Boolean(batch && !batch.complete);
  const approvalToolNames = batch?.actions.length ? batch.actions : [name];
  // A batch tool declared as a write makes each of its actions one.
  const declaredReadOnlyFor = (toolName: string) =>
    toolName === name || declaredReadOnly === false
      ? declaredReadOnly
      : ctx.tools.connector.get(toolName)?.readOnly;
  // Resolve persisted policy at the execution boundary, including test runs.
  const monitorRoutine = run.routineId
    ? await deps.prisma.routine.findUnique({
        where: { id: run.routineId },
        select: { monitor: true },
      })
    : null;
  // A deleted routine cannot silently shed its persisted restrictions.
  if (run.routineId && !monitorRoutine) return { result: { error: "Routine policy unavailable" } };
  const monitorDecision =
    monitorRoutine?.monitor == null
      ? undefined
      : workspaceMonitorToolDecision(monitorRoutine.monitor, {
          name,
          connector: viaConnector,
          readOnly: approvalToolNames.every((toolName) => declaredReadOnlyFor(toolName) === true)
            ? true
            : declaredReadOnly === false
              ? false
              : undefined,
          batchComplete: !unidentifiedAction,
          batch: Boolean(batch),
          route: connectorCall.route,
        });
  if (monitorDecision === "deny")
    return { result: { error: "Workspace monitor capability denied" } };
  const sourceEvidence =
    monitorDecision === "allow" && viaConnector
      ? evidenceForMonitorCall(monitorRoutine?.monitor, connectorCall.route, Boolean(batch))
      : undefined;
  const requiresUnattendedApproval =
    (unidentifiedAction && run.trigger === "webhook") ||
    approvalToolNames.some((toolName) =>
      unattendedTriggerToolRequiresApproval(
        run.trigger,
        toolName,
        viaConnector,
        declaredReadOnlyFor(toolName),
      ),
    );
  const connectorProviders = ctx.tools.connectedPlugins.map((plugin) => plugin.provider);
  const connectorKind = connectorKindFromToolName(name, connectorProviders);
  // paid_request with only a purchase id sends the request its approval already named.
  const sendsToSite =
    SITE_SENDING_TOOLS.has(name) && (name === "web_fetch" || args.url !== undefined);
  const fetchUrl = sendsToSite ? normalizedHttpUrl(String(args.url ?? "")) : undefined;
  const fetchSite = fetchUrl ? urlSite(fetchUrl) : undefined;
  if (sendsToSite && !fetchSite) return { result: { error: "url must be an http(s) URL" } };
  if (fetchUrl && fetchUrl.length > MAX_FETCH_URL_LENGTH)
    return {
      result: {
        error: `url must be at most ${MAX_FETCH_URL_LENGTH} characters`,
      },
    };
  // The card, the stored effect and the request all use the URL the gate checked.
  if (fetchUrl) {
    args = { ...args, url: fetchUrl };
    effectRequest = name === "paid_request" ? paidRequestEffect(args) : args;
  }
  const connectorTrusts = connectorTrustKeys(
    batch?.actions,
    connectorCall.route,
    connectorKind,
    connectorProviders,
  );
  const siteGate =
    fetchUrl && fetchSite
      ? outboundSiteGate({
          site: fetchSite,
          trusted:
            ctx.trust.searchResultUrls.has(fetchUrl) ||
            (name === "web_fetch" && RAKAZO_DOCS_URLS.includes(fetchUrl)) ||
            (await ctx.trust.loadTrustedSites()).has(fetchSite),
          rules: await ctx.trust.loadApprovalRules(),
        })
      : "allow";
  const watch = name === "schedule_create" ? watchFromTool(args.watch) : undefined;
  // A tool watch repeats its read unattended, so it passes the read check that call would now.
  const watchedTool = watch?.kind === "tool" ? watch.tool : undefined;
  const readTrusts = watchedTool
    ? connectorTrustKeys(
        undefined,
        ctx.tools.connector.get(watchedTool)?.route,
        connectorKindFromToolName(watchedTool, connectorProviders),
        connectorProviders,
      )
    : viaConnector &&
        !unidentifiedAction &&
        approvalToolNames.every(
          (toolName) => !connectorToolRequiresApproval(toolName, declaredReadOnlyFor(toolName)),
        )
      ? connectorTrusts
      : undefined;
  const connectorReadGated =
    readTrusts !== undefined &&
    connectorReadRequiresApproval({
      tainted: await isRunTainted(ctx),
      connectorTrusted: await ctx.trust
        .loadTrustedConnectors()
        .then((trusted) => readTrusts.every((trust) => trusted.has(trust))),
    });
  // This schedules unattended shell execution; require a person to approve
  // the command once, rather than letting an allow rule or reviewer schedule it.
  const commandWatch = watch?.kind === "command";
  // A routine's prompt counts as the owner's words when it runs, so the sites it names are
  // ones its runs may fetch. Once outside content entered this run, a routine naming a
  // site this run was not given needs a person: a reviewer would judge it on this run's
  // context, and passing it would trust the site for every later run.
  const scheduleNamesNewSite =
    (name === "schedule_create" ||
      name === "create_child_routine" ||
      (name === "schedule_update" && Boolean(args.prompt))) &&
    (await isRunTainted(ctx)) &&
    (await ctx.trust.routineNamesNewSite(String(args.prompt ?? "")));
  const requiresApprovalByDefault =
    request.heldForApproval ||
    commandWatch ||
    requiresUnattendedApproval ||
    siteGate === "new" ||
    unidentifiedAction ||
    approvalToolNames.some((toolName) =>
      toolRequiresApproval(toolName, viaConnector, declaredReadOnlyFor(toolName)),
    );
  // A gated read still fails closed when its review errors, and keeps its approval key.
  const gated = requiresApprovalByDefault || connectorReadGated;
  const requiresMandatoryApproval =
    commandWatch ||
    scheduleNamesNewSite ||
    requiresUnattendedApproval ||
    toolRequiresExplicitApproval(name);
  // Never ask runs everything else: only another owner's connection could have been steered into it.
  const guardedInNeverAsk = name === "respond_agent_connection";
  const resolvedRules = resolveActionApprovalForTools({
    tools: approvalToolNames.map((toolName) => ({
      name: toolName,
      connectorKind:
        toolName === name ? connectorKind : connectorKindFromToolName(toolName, connectorProviders),
      readOnly: declaredReadOnlyFor(toolName),
    })),
    wrapper: batch ? { name, connectorKind } : undefined,
    site: fetchSite,
    rules: await ctx.trust.loadApprovalRules(),
  });
  const approvalResolved =
    unidentifiedAction && resolvedRules.decision === "allow"
      ? { ...resolvedRules, decision: "ask" as const }
      : resolvedRules;
  const mode = approvalModeFromPreference(await ctx.trust.loadAutoReviewPreference());
  const reviewable = mode === "auto" && !requiresMandatoryApproval;
  const injectedReview = reviewable ? deps.autoReview : undefined;
  const reviewSettings = !reviewable || injectedReview ? null : await ctx.trust.loadApprovalModel();
  const memberChecker = reviewSettings?.primarySource === "member";
  const checker = !reviewable
    ? undefined
    : reviewSettings
      ? reviewSettings.primary
        ? {
            provider: reviewSettings.primary.provider,
            model: reviewSettings.primary.modelId,
            thinkingLevel: reviewSettings.primary.thinkingLevel,
            credentialId: reviewSettings.primary.credentialId,
          }
        : null
      : resolveAutoReviewChecker();
  const checkerConfigured =
    reviewable &&
    (Boolean(injectedReview) ||
      memberChecker ||
      Boolean(reviewSettings?.backups.length) ||
      (checker
        ? isAutoReviewCheckerConfigured({}) ||
          Boolean(
            await findConnectedModelCredential(
              deps.prisma,
              deps.secretStore,
              { userId: run.userId, spaceId: run.spaceId },
              checker.provider,
            ),
          )
        : false));
  const plan = USER_COMPUTER_TOOLS.has(name)
    ? await userComputerGate(ctx, approvalResolved.decision === "deny", name, args)
    : planActionGate({
        resolved: approvalResolved,
        mode,
        mandatory: requiresMandatoryApproval,
        steerable:
          guardedInNeverAsk && mode === "never"
            ? !ctx.source.ownerStartedRun || (await isRunTainted(ctx))
            : undefined,
        consequential: requiresApprovalByDefault,
        reviewOnly: connectorReadGated,
        checkerConfigured,
        newDestination: siteGate === "new",
      });
  if (plan === "deny") {
    await auditToolCall(ctx, name, "denied", {
      reason: approvalResolved.decision === "deny" ? "rule" : "never_asks",
    });
    return {
      result: {
        error: `${name} is blocked in this space${blockingRuleSuffix(approvalResolved)}. Don't try it another way; tell the user it's blocked.`,
      },
    };
  }
  let reviewReason: string | undefined;
  let gateDecision: "ask" | "allow" = plan === "ask" ? "ask" : "allow";
  const needsApprovalEarly = plan === "ask" || plan === "judge";
  // A resumed approval keeps its key even if "Always allow" changed the policy.
  const usesApprovalKey =
    nextApprovedTool || name === "request_secret" || needsApprovalEarly || gated;
  // Count before choosing a key so an approved replay (occurrence 0 / base
  // key) cannot collide with a later identical-args call in this attempt.
  // request_secret stays single-use: retries must reuse the same card.
  const occurrence =
    name === "request_secret" || name === "connect_app"
      ? 0
      : nextMutatingEffectOccurrence(
          ctx,
          replayEffectToolName,
          args,
          executionId,
          approvedEffectKey,
        );
  // An approved replay claims the row the user approved. A derived key can differ
  // (another call's occurrence count), which would ask again and strand the approval.
  const effectKey =
    approvedEffectKey ??
    (usesApprovalKey && occurrence === 0
      ? approvalEffectKey(runId, replayEffectToolName, args)
      : toolEffectIdempotencyKey(runId, replayEffectToolName, args, occurrence));
  if (connectorCall.route?.connectorId === "mcp") {
    const catalog = catalogApprovalDetails(effectRequest, CATALOG_APPROVAL_TOOL);
    if (catalog?.route) {
      const boundRoute = {
        ...catalog.route,
        __rakazoEffectiveArgsSha256V1: mcpEffectiveArgsFingerprint(args),
      };
      effectRequest = catalogApprovalRequest(catalog.toolName, catalog.args, CATALOG_APPROVAL_TOOL, boundRoute);
    }
  }
  // Connector read-only hints must not bypass approval, review, or replay decisions.
  // A fetch to a new site is gated like any action, so it needs an effect to approve.
  const applied =
    READ_ONLY_AGENT_TOOLS.has(name) &&
    siteGate !== "new" &&
    nextApprovedTool !== name &&
    !approvedEffectKey
      ? undefined
      : await recordEffect(
          deps,
          run,
          replayEffectToolName,
          effectKey,
          effectRequest,
          executionId,
          ctx.state.effects.consumedIds,
          batch && (batch.complete ? batch.actions : []),
          connectorCall.route?.connectorId === "mcp" || name.startsWith("mcp__")
            ? { route: connectorCall.route, args }
            : undefined,
          connectorCall.route?.connectorId === "pipedream" ? connectorCall.route : undefined,
          request.pipedream?.binding,
          connectorCall.route?.connectorId === "installed" && connectorCall.route.installedMcp
            ? connectorCall.route : undefined,
          request.installedApprovedRequest,
        );

  if (applied && "uncertainIdentity" in applied) {
    return {
      result: {
        error:
          connectorCall.route?.installedMcp
            ? "An earlier execution could not be matched to this connection and occurrence. Check the destination first. To request a new attempt, stop this run if needed, then send a new message."
            : "An earlier execution could not be matched to this connection and occurrence. Verify the destination before retrying.",
        uncertain: true,
      },
    };
  }

  // Refuse a repeat of a tool the user denied earlier in this run. Refusals carry a result,
  // so only real denies match. A stored row is checked only while it still waits for an
  // answer. web_fetch and secret_request target one site per call; request_secret and
  // connect_app name their own target.
  const repeatChecked =
    applied &&
    (!applied.duplicate || applied.effect.status === "intended") &&
    !["web_fetch", "secret_request", "request_secret", "connect_app"].includes(name);
  const deniedEarlier = repeatChecked
    ? (
        await deps.prisma.externalEffect.findMany({
          where: { runId, status: "denied", kind: replayEffectToolName },
          select: { request: true, result: true },
        })
      ).flatMap((effect) =>
        effect.result == null
          ? [
              boundDirectApprovalDetails(effect.request, CATALOG_APPROVAL_TOOL)?.args ??
                effect.request,
            ]
          : [],
      )
    : [];
  if (
    applied &&
    repeatsDeniedAction({
      toolName: replayEffectToolName,
      args,
      denied: deniedEarlier,
    })
  ) {
    await deps.prisma.externalEffect.updateMany({
      where: { id: applied.effect.id, status: "intended", dispatchClaimToken: null },
      data: { status: "denied", result: { refused: "repeat" } },
    });
    return { result: { error: DENIED_ACTION_ERROR } };
  }

  const runAutoReview = async () => {
    const judged = await reviewToolCall(ctx, {
      name,
      args,
      connectorKind,
      newSite: siteGate === "new",
      fetchUrl,
      matchingRules: approvalResolved.matchingRules,
      gated,
      applied,
      injectedReview,
      checker,
      reviewSettings,
      memberChecker,
    });
    if (!judged) return;
    reviewReason = judged.reason;
    gateDecision = judged.decision;
  };

  if (applied && plan === "judge" && (injectedReview || checker)) {
    if (!applied.duplicate) {
      await runAutoReview();
    } else {
      const priorDecision = applied.effect.reviewDecision;
      if (priorDecision === "ask" || priorDecision === "error") {
        reviewReason =
          typeof applied.effect.reviewReason === "string" ? applied.effect.reviewReason : undefined;
        gateDecision = "ask";
      } else if (priorDecision === "pass") {
        reviewReason =
          typeof applied.effect.reviewReason === "string" ? applied.effect.reviewReason : undefined;
        gateDecision = "allow";
      } else {
        await runAutoReview();
      }
    }
  } else if (applied?.duplicate && plan === "ask") {
    gateDecision = "ask";
  }
  if (context.signal.aborted) return { result: pauseForApproval(ctx) };
  if (
    siteGate === "new" &&
    newSiteOutcome({ trigger: run.trigger, decision: gateDecision }) === "deny"
  ) {
    if (applied) {
      await deps.prisma.externalEffect.updateMany({
        where: { id: applied.effect.id, status: "intended", dispatchClaimToken: null },
        data: { status: "denied" },
      });
    }
    return {
      result: {
        error: `Fetching ${fetchSite} needs approval, and a webhook run cannot ask.`,
      },
    };
  }

  const needsApproval = gateDecision === "ask";
  const call = createToolCall(
    ctx,
    {
      name,
      args,
      executionId,
      observer,
      connectorCall,
      effectKey,
      applied,
      nextApprovedTool,
      ...(request.pipedream ? { pipedream: request.pipedream } : {}),
      bypassApproval: gateDecision === "allow" && gated,
    },
    sourceEvidence,
    request.installedApprovedRequest,
  );
  const card = {
    reviewReason,
    summary: request.fleetSummary,
    batch: connectorTool?.batch,
  };

  if (applied?.duplicate) {
    const gate = resolveDuplicateEffectGate(applied.effect, name);
    if (gate.action === "return") {
      if (name === "request_secret") {
        const replacementSecret = await deps.prisma.secret.findFirst({
          where: {
            spaceId: run.spaceId,
            userId: run.userId,
            kind: runSecretKind(runId),
          },
          select: { id: true, createdAt: true },
        });
        if (!replacementSecret) return { result: gate.result };
        // Crash between persist and delete leaves the same OTP row. Do not
        // resubmit it to the connector; only newer rows are replacements.
        const effectUpdatedAt = applied.effect.updatedAt;
        if (
          !(effectUpdatedAt instanceof Date) ||
          resolveCompletedSecretLeftover({
            secretCreatedAt: replacementSecret.createdAt,
            effectUpdatedAt,
          }) === "drop_leftover"
        ) {
          await deps.prisma.secret.delete({
            where: { id: replacementSecret.id },
          });
          return { result: gate.result };
        }
      } else {
        return { result: gate.result };
      }
    }
    if (gate.action === "paused") {
      if (name === "request_secret") {
        const current = await deps.prisma.run.findUnique({
          where: { id: runId },
          select: { status: true },
        });
        if (current?.status === "waiting_input") {
          return { result: pauseForSecret(ctx) };
        }
        // An intended secret request resumes protected entry below, including
        // recovery after action approval but before the card was committed.
      } else if (!needsApproval) {
        const early = await call.claimOrReturn("intended");
        if (early !== undefined) return { result: early };
      } else {
        const current = await deps.prisma.run.findUnique({
          where: { id: runId },
          select: { status: true },
        });
        if (current?.status === "waiting_input") {
          return { result: pauseForApproval(ctx) };
        }
        return { result: await requestApproval(ctx, call, card) };
      }
    } else if (gate.action === "uncertain") {
      return {
        result: await settleToolUncertainty(ctx, call, applied.effect.id, gate.toolName),
      };
    } else if (gate.action === "execute") {
      const early = await call.claimOrReturn("approved");
      if (early !== undefined) return { result: early };
    }
  } else if (needsApproval && applied) {
    return { result: await requestApproval(ctx, call, card) };
  } else if (call.bypassApproval && applied) {
    const early = await call.claimOrReturn("intended");
    if (early !== undefined) return { result: early };
  }
  // A monitor read must have an executing effect before dispatch, so a worker
  // lost while the source is being read cannot replay it as merely intended.
  if (sourceEvidence && applied && !call.claimedEffect) {
    const early = await call.claimOrReturn("intended");
    if (early !== undefined) return { result: early };
  }
  if ((connectorCall.route?.connectorId === "mcp" || connectorCall.route?.installedMcp || call.pipedream) && !call.claimedEffect) {
    if (!applied) return { result: uncertainEffectResult(name, args) };
    const early = await call.claimOrReturn("intended");
    if (early !== undefined) return { result: early };
  }
  // Past the gate: this destination is now one the run was given. A search result's exact
  // URL trusts only that URL, never the rest of its site.
  if (fetchSite && siteGate === "new") (await ctx.trust.loadTrustedSites()).add(fetchSite);
  if (viaConnector) {
    const trusted = await ctx.trust.loadTrustedConnectors();
    for (const trust of connectorTrusts) trusted.add(trust);
  }
  return { call };
}

/** A bot's consequential tool call, recorded in its organization's audit log. */
export async function auditToolCall(
  ctx: RunContext,
  tool: string,
  outcome: "success" | "failure" | "denied",
  metadata: AuditEventInput["metadata"],
  recorded: Pick<AuditEventInput, "action" | "actor"> = {
    action: "tool.call",
    actor: { type: "bot", id: ctx.bot.id, label: ctx.bot.name },
  },
): Promise<void> {
  await recordAuditEvent({
    ...recorded,
    spaceId: ctx.run.spaceId,
    target: { type: "tool", id: tool, label: humanizeToolName(tool) },
    outcome,
    runId: ctx.runId,
    threadId: ctx.thread.id,
    metadata,
  });
}

function blockingRuleSuffix(resolved: ReturnType<typeof resolveActionApprovalForTools>): string {
  const labels = decisiveActionApprovalRules(resolved).map((rule) => {
    const value = rule.matchValue.trim().replace(/\s+/g, " ");
    return JSON.stringify(rule.matchKind === "site" ? value : humanizeToolName(value));
  });
  if (labels.length === 0) return "";
  return ` by the saved ${labels.length === 1 ? "rule" : "rules"} ${labels.join(", ")}`;
}

function createToolCall(
  ctx: RunContext,
  fields: Omit<
    ToolCall,
    | "claimedEffect"
    | "mcpClaimToken"
    | "monitorSourceRecheck"
    | "persistEffectResult"
    | "finish"
    | "finishMonitorUncertain"
    | "finishConnectorUncertain"
    | "finishInvalidScreenAction"
    | "finishInvalidSharedMemory"
    | "finishComputerUnavailable"
    | "finishStdioMcpForbidden"
    | "finishInstructionPreconditionFailed"
    | "claimOrReturn"
  >,
  monitorReadEvidence: string | undefined,
  installedApprovedRequest: unknown,
): ToolCall {
  const { deps } = ctx;
  const { name, args, applied } = fields;
  const installedBinding = installedMcpBinding(fields.connectorCall.route?.installedMcpBinding);
  const recheckInstalled = async (tx: Prisma.TransactionClient, effectId: string): Promise<boolean | "uncertain"> => {
    if (!installedBinding) return "uncertain";
    const available = await lockInstalledMcpBinding(tx, ctx.run, installedBinding);
    const rows = await tx.$queryRaw<Array<{ request: unknown }>>`
      SELECT request FROM external_effects WHERE id = ${effectId} FOR UPDATE`;
    const route = boundDirectApprovalDetails(rows[0]?.request, CATALOG_APPROVAL_TOOL)?.route ??
      catalogApprovalDetails(rows[0]?.request, CATALOG_APPROVAL_TOOL)?.route;
    if (rows.length !== 1 || !isDeepStrictEqual(rows[0]?.request, installedApprovedRequest ?? applied?.effect.request) ||
      !sameInstalledMcpBinding(installedBinding, installedMcpBinding(route?.installedMcpBinding))) return "uncertain";
    return available;
  };
  const call: ToolCall = {
    ...fields,
    monitorSourceRecheck: monitorReadEvidence !== undefined,
    claimedEffect: false,
    persistEffectResult: (result) =>
      applied && call.mcpClaimToken
        ? finishMcpEffect(
            deps,
            ctx.run,
            applied.effect.id,
            call.mcpClaimToken,
            result,
            false,
          ).catch(() => false)
        : applied
          ? completeEffect(
              deps,
              applied.effect.id,
              call.claimedEffect ? "executing" : "intended",
              result,
            )
          : Promise.resolve(true),
    finish: async (result) => {
      if (installedBinding && applied && call.mcpClaimToken) {
        const unknown = uncertainEffectResult(name, args);
        const settled = await finishPipedreamEffect(
          deps, ctx.run, applied.effect.id, call.mcpClaimToken, result, unknown, false,
          async (tx) => (await recheckInstalled(tx, applied.effect.id)) === true,
        ).catch(() => ({ settled: false, uncertain: true }));
        return settled.settled && !settled.uncertain ? result : unknown;
      }
      if (call.pipedream && applied && call.mcpClaimToken) {
        const unknown = uncertainEffectResult(name, args);
        const settled = await finishPipedreamEffect(
          deps, ctx.run, applied.effect.id, call.mcpClaimToken, result, unknown, false,
          (tx) => recheckPipedreamEffect(tx, applied.effect.id, call.pipedream!),
        ).catch(() => ({ settled: false, uncertain: true }));
        return settled.settled && !settled.uncertain ? result : unknown;
      }
      const persisted = monitorReadEvidence
        ? await persistMonitorReadEvidence(
            result,
            () => call.persistEffectResult(result),
            () =>
              deps.events.append({
                spaceId: ctx.run.spaceId,
                threadId: ctx.run.threadId,
                botId: ctx.run.botId,
                runId: ctx.runId,
                type: "effect.recorded",
                payload: { evidence: monitorReadEvidence },
              }),
          )
        : await call.persistEffectResult(result);
      return persisted ? result : uncertainEffectResult(name, args);
    },
    finishMonitorUncertain: async () => {
      if (call.mcpClaimToken) return call.finishConnectorUncertain();
      if (!monitorReadEvidence || !applied || !call.claimedEffect)
        return uncertainEffectResult(name, args);
      return settleRunEffectUncertainty(deps, ctx.runId, applied.effect.id, name, args);
    },
    finishConnectorUncertain: async () => {
      const result = uncertainEffectResult(name, args);
      if (installedBinding && applied && call.mcpClaimToken) {
        await finishPipedreamEffect(
          deps, ctx.run, applied.effect.id, call.mcpClaimToken, result, result, true,
          async (tx) => (await recheckInstalled(tx, applied.effect.id)) === true,
        ).catch(() => undefined);
        return result;
      }
      if (call.pipedream && applied && call.mcpClaimToken) {
        await finishPipedreamEffect(
          deps, ctx.run, applied.effect.id, call.mcpClaimToken, result, result, true,
          (tx) => recheckPipedreamEffect(tx, applied.effect.id, call.pipedream!),
        ).catch(() => undefined);
        return result;
      }
      if (applied && call.mcpClaimToken) {
        await finishMcpEffect(
          deps,
          ctx.run,
          applied.effect.id,
          call.mcpClaimToken,
          result,
          true,
        ).catch(() => false);
      } else if (applied && call.claimedEffect) {
        await settleRunEffectUncertainty(deps, ctx.runId, applied.effect.id, name, args).catch(() => undefined);
      }
      return result;
    },
    finishInvalidScreenAction: async (result) => {
      if (name !== "user_computer_act") throw new Error("Invalid local rejection boundary");
      if (!applied) return result;
      const persisted = await settleInvalidScreenAction(
        deps,
        ctx.runId,
        applied.effect.id,
        call.claimedEffect ? "executing" : "intended",
        result,
      );
      return persisted ? result : uncertainEffectResult(name, args);
    },
    finishInvalidSharedMemory: async (result) => {
      if (name !== "save_shared_memory") throw new Error("Invalid local rejection boundary");
      if (!applied) return result;
      const persisted = await settleLocalEffectRejection(
        deps,
        ctx.runId,
        applied.effect.id,
        call.claimedEffect ? "executing" : "intended",
        result,
        "invalid_shared_memory",
      );
      return persisted ? result : uncertainEffectResult(name, args);
    },
    finishComputerUnavailable: async (result) => {
      if (!["user_computer_shell", "user_computer_act", "user_computer_observe"].includes(name))
        throw new Error("Invalid local rejection boundary");
      if (!applied) return result;
      const persisted = await settleLocalEffectRejection(
        deps,
        ctx.runId,
        applied.effect.id,
        call.claimedEffect ? "executing" : "intended",
        result,
        "computer_unavailable",
      );
      return persisted ? result : uncertainEffectResult(name, args);
    },
    finishStdioMcpForbidden: async (result) => {
      if (name !== "add_mcp_server") throw new Error("Invalid local rejection boundary");
      if (!applied) return result;
      const persisted = await settleLocalEffectRejection(
        deps,
        ctx.runId,
        applied.effect.id,
        call.claimedEffect ? "executing" : "intended",
        result,
        "stdio_mcp_forbidden",
      );
      return persisted ? result : uncertainEffectResult(name, args);
    },
    finishInstructionPreconditionFailed: async (result) => {
      if (name !== "update_bot") throw new Error("Invalid local rejection boundary");
      if (!applied) return result;
      const persisted = await settleLocalEffectRejection(
        deps,
        ctx.runId,
        applied.effect.id,
        call.claimedEffect ? "executing" : "intended",
        result,
        "instruction_precondition_failed",
      );
      return persisted ? result : uncertainEffectResult(name, args);
    },
    claimOrReturn: async (from) => {
      const mcp = call.connectorCall.route?.connectorId === "mcp" || Boolean(call.connectorCall.route?.installedMcp) || Boolean(call.pipedream);
      let token: string | undefined;
      try {
        token = mcp ? await claimMcpEffect(
          deps, ctx.run, applied!.effect.id, from,
          call.pipedream ? (tx) => recheckPipedreamEffect(tx, applied!.effect.id, call.pipedream!) :
            installedBinding ? (tx) => recheckInstalled(tx, applied!.effect.id) : undefined,
        ) : undefined;
      } catch (error) {
        if (error instanceof PipedreamBindingChangedError)
          return { error: "The connected account changed. No operation was sent; refresh the tool and review again." };
        if (error instanceof PipedreamBindingUncertainError) return uncertainEffectResult(name, args);
        throw error;
      }
      if (token || (!mcp && (await claimEffect(deps, ctx.runId, applied!.effect.id, from)))) {
        call.claimedEffect = true;
        call.mcpClaimToken = token;
        return undefined;
      }
      const current = await deps.prisma.externalEffect.findUnique({
        where: { id: applied!.effect.id },
      });
      if (current) {
        const retryGate = resolveDuplicateEffectGate(current, name);
        if (retryGate.action === "return") return retryGate.result;
        if (retryGate.action === "uncertain") {
          return settleToolUncertainty(ctx, call, applied!.effect.id, name);
        }
      }
      throw uncertainEffectError(name);
    },
  };
  return call;
}

async function settleToolUncertainty(
  ctx: RunContext,
  call: ToolCall,
  effectId: string,
  toolName: string,
) {
  if (call.name === "generate_image" || call.name === "generate_video") {
    const recovered = await callMediaTool(ctx, call, true);
    if (
      recovered !== undefined &&
      (await completeEffect(ctx.deps, effectId, "executing", recovered))
    )
      return recovered;
  }
  return settleRunEffectUncertainty(ctx.deps, ctx.runId, effectId, toolName, call.args);
}

/** Ask the owner through an approval card. Parallel calls share the first call's pause. */
function requestApproval(ctx: RunContext, call: ToolCall, card: ApprovalCard) {
  const { approval } = ctx.state;
  // Parallel calls can need approval at once. Only the first saves the turn and shows
  // its card; the others wait for that pause. Otherwise a later call's save could make
  // the turn resume a call other than the one the user approved.
  if (approval.request) return approval.request.then(() => pauseForApproval(ctx));
  approval.request = showApprovalCard(ctx, call, card);
  return approval.request;
}

async function showApprovalCard(ctx: RunContext, call: ToolCall, card: ApprovalCard) {
  const { deps, run, runId, bot, thread } = ctx;
  const { name, args, executionId, applied } = call;
  if (!(await renewRunLease(deps, runId, ctx.workerId, ctx.fence))) {
    // Another worker owns the run now; exit without leaving a local pause card.
    return pauseForApproval(ctx);
  }
  await ctx.computer.checkpoint.flush();
  await persistTurnCheckpoint(ctx, executionId);
  await ctx.settleRunningHelpers();
  const paused = await deps.events.pauseRunForInput({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId,
    attemptId: ctx.attempt.id,
    leaseOwner: ctx.workerId,
    leaseFence: ctx.fence,
    blocks: [
      buildApprovalAskBlock(
        applied!.effect.id,
        name,
        name === "update_bot" && "previousInstructions" in args ? { ...args, botId: bot.id } : args,
        ctx.secrets,
        card,
      ),
    ],
  });
  // pauseRunForInput returning false after a successful renew means the run row no
  // longer matches this worker. Exiting via pauseForApproval() would leave the run
  // stuck in "running" with no ask card — fail instead so the user can retry.
  if (!paused) {
    throw new Error("Could not pause this run for approval; try sending again.");
  }
  if (paused.continuationRunId) {
    await deps.jobs
      .enqueue(runContinueJob(paused.continuationRunId))
      .catch((error) => getLogger().error("steering continuation enqueue", error));
  }
  await notifyRun(deps, run, {
    kind: "help",
    title: `${displayName(bot.name, "Bot")} needs approval`,
    body: `Review before ${name}`,
    botId: bot.id,
    threadId: thread.id,
  });
  return pauseForApproval(ctx);
}

/**
 * Run the configured reviewer (and its backups) on a call and store its verdict on the
 * effect. Returns nothing when there is no reviewer or the run was cancelled.
 */
async function reviewToolCall(
  ctx: RunContext,
  review: ToolReview,
): Promise<{ reason: string | undefined; decision: "ask" | "allow" } | undefined> {
  const { deps, run, runId, bot, thread, context } = ctx;
  const { name, args, connectorKind, fetchUrl, gated, applied } = review;
  const { injectedReview, checker, reviewSettings, memberChecker } = review;
  if (!injectedReview && !checker && !reviewSettings?.backups.length) return;
  try {
    const botDescription = redactSecrets(`${bot.name}\n${bot.description}`, ctx.secrets);
    // A new site is judged on the full URL and the owner's own words only: the task
    // prompt of a webhook or bot-started run carries text someone else wrote.
    const reviewRequest: AutoReviewRequest =
      review.newSite && fetchUrl
        ? {
            toolName: name,
            connectorKind,
            args: { url: redactSecrets(fetchUrl, ctx.secrets) },
            userTask: redactSecrets(await ctx.trust.loadOwnerWords(), ctx.secrets),
            botDescription,
            matchingRules: review.matchingRules,
            newSite: true,
          }
        : {
            toolName: name,
            connectorKind,
            args: redactToolArgsForReview(args, ctx.secrets),
            userTask: redactSecrets(ctx.task.prompt, ctx.secrets),
            botDescription,
            matchingRules: review.matchingRules,
          };
    const reviewContext: AdapterContext = {
      operationId: `auto-review:${runId}`,
      traceId: `auto-review:${runId}`,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: bot.id,
      runId,
      signal: context.signal,
    };
    const checkerProvider = (checker: AutoReviewChecker) =>
      autoReviewCheckerProvider(
        deps,
        {
          runId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          threadId: thread.id,
        },
        {
          injectedReview,
          memberChecker,
          backups: reviewSettings?.backups,
          registerSecrets: (values) => ctx.secrets.push(...values),
        },
        checker,
      );
    const judge = await reviewWithBackups(
      [
        ...(checker
          ? [checker]
          : injectedReview
            ? [{ provider: "injected", model: "injected" }]
            : []),
        ...(reviewSettings?.backups.map((choice) => ({
          provider: choice.provider,
          model: choice.modelId,
          thinkingLevel: choice.thinkingLevel,
          credentialId: choice.credentialId,
        })) ?? []),
      ],
      async (checker) => {
        const provider = await checkerProvider(checker);
        return provider.review(reviewRequest, reviewContext);
      },
      context.signal,
    );
    if (context.signal.aborted) return;
    const verdict = {
      reason: judge.reason,
      decision: applyJudgeDecision({
        decision: judge.decision,
        consequential: gated,
      }),
    };
    if (applied) {
      await deps.prisma.externalEffect.update({
        where: { id: applied.effect.id, dispatchClaimToken: null },
        data: {
          reviewDecision: judge.decision,
          reviewReason: judge.reason,
          reviewModel: judge.model,
        },
      });
    }
    await auditAutoReview(ctx, name, applied, judge.decision, judge.model);
    return verdict;
  } catch {
    // Cancellation must not write a review the next attempt would reuse.
    if (context.signal.aborted) return;
    // Auth/refresh failures must fail closed like a checker error, not fail the run.
    const reviewReason = "Checker could not authenticate.";
    const verdict = {
      reason: reviewReason,
      decision: applyJudgeDecision({ decision: "error", consequential: gated }),
    };
    const reviewModel = checker
      ? `${checker.provider}/${checker.model}`
      : (injectedReview?.describe().id ?? "auto-review");
    if (applied) {
      await deps.prisma.externalEffect.update({
        where: { id: applied.effect.id, dispatchClaimToken: null },
        data: { reviewDecision: "error", reviewReason, reviewModel },
      });
    }
    await auditAutoReview(ctx, name, applied, "error", reviewModel);
    return verdict;
  }
}

function auditAutoReview(
  ctx: RunContext,
  tool: string,
  applied: AppliedEffect | undefined,
  decision: string,
  model: string | undefined,
): Promise<void> {
  return auditToolCall(
    ctx,
    tool,
    decision === "error" ? "failure" : "success",
    { effectId: applied?.effect.id, decision },
    {
      action: "approval.auto_reviewed",
      actor: { type: "system", label: model },
    },
  );
}
