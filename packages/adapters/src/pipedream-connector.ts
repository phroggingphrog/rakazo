import { createHmac } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { catalogToolPrefix } from "./approval-effect.js";
import { collectPages, filterCatalog } from "./composio-connector.js";
import {
  combineSignals,
  redactConnectorPayloadStrict,
  sanitizeConnectorError,
} from "./connector-safety.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  DIRECT_TOOL_LIMIT,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  loadCatalogEntry,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { callRemoteMcpTool, listRemoteMcpTools } from "./remote-mcp.js";
import { isVitestRuntime } from "./test-runtime.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

const API_BASE = "https://api.pipedream.com";
const MCP_ENDPOINT = "https://remote.mcp.pipedream.net/v3";
const DIRECTORY_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_PIPEDREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Tool argument naming which approved account runs the call when an app has several. */
const ACCOUNT_ARGUMENT = "connected_account";

export interface PipedreamConnectorConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: "development" | "production";
  identitySecret: string;
}

export interface PipedreamEnvironmentValues {
  pipedreamClientId?: string;
  pipedreamClientSecret?: string;
  pipedreamProjectId?: string;
  pipedreamEnvironment?: string;
  encryptionKey: string;
}

export function pipedreamConfigFromEnv(
  values: PipedreamEnvironmentValues,
): PipedreamConnectorConfig {
  return {
    clientId: values.pipedreamClientId ?? "",
    clientSecret: values.pipedreamClientSecret ?? "",
    projectId: values.pipedreamProjectId ?? "",
    environment: values.pipedreamEnvironment === "production" ? "production" : "development",
    identitySecret: values.encryptionKey,
  };
}

export type PipedreamConnectorDependencies = RemoteTransportDependencies;

type PipedreamApp = {
  id: string;
  name_slug: string;
  name: string;
  img_src?: string;
};

type ApprovedAccount = { id: string; ref: string; label: string };

type PipedreamAccount = {
  id: string;
  healthy?: boolean;
  dead?: boolean;
  app?: PipedreamApp;
};

export function isPipedreamEnabled(config: Partial<PipedreamConnectorConfig>): boolean {
  return Boolean(
    config.clientId &&
      config.clientSecret &&
      config.projectId &&
      config.environment &&
      config.identitySecret &&
      !isVitestRuntime(),
  );
}

function securePipedreamConnectUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pipedream did not return a secure HTTPS connect URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Pipedream did not return a secure HTTPS connect URL");
  }
  return url;
}

export class PipedreamConnector implements ManagedConnectorProvider {
  private accessToken?: { value: string; expiresAt: number };
  private accessTokenRequest?: Promise<string>;
  private directory?: { value: PipedreamApp[]; expiresAt: number };
  private directoryRequest?: Promise<PipedreamApp[]>;

  constructor(
    private readonly config: PipedreamConnectorConfig,
    private readonly dependencies: PipedreamConnectorDependencies = {},
  ) {}

  describe() {
    return {
      id: "pipedream",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async pipedreamAccountNamespace(context: AdapterContext): Promise<string> {
    return createHmac("sha256", this.config.identitySecret)
      .update("rakazo:pipedream-account-namespace:v2\0")
      .update(JSON.stringify([
        this.config.projectId, this.config.environment, this.config.clientId, this.config.clientSecret,
        context.spaceId, context.userId,
      ]))
      .digest("hex");
  }

  async catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]> {
    const [apps, connected] = await Promise.all([
      this.apps(),
      this.listConnectedExternalIds(context),
    ]);
    const connectedSet = new Set(connected);
    return filterCatalog(
      apps.map((app) => ({
        connectorId: "pipedream",
        slug: app.name_slug,
        name: app.name,
        logo: app.img_src ?? null,
        connected: connectedSet.has(app.name_slug),
        noAuth: false,
      })),
      query ?? "",
    );
  }

  async warmDirectory(): Promise<void> {
    await this.apps();
  }

  async listConnectedExternalIds(context: AdapterContext): Promise<string[]> {
    const accounts = await this.accounts(context);
    return [
      ...new Set(
        accounts
          .filter((account) => account.healthy !== false && account.dead !== true)
          .map((account) => account.app?.name_slug)
          .filter((slug): slug is string => Boolean(slug)),
      ),
    ];
  }

  private async allTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const apps =
      context.connectedConnections
        ?.filter((connection) => connection.connectorId === "pipedream")
        .map((connection) => connection.externalId) ?? [];
    if (apps.length === 0) return [];
    const token = await this.token();
    const groups = await Promise.all(
      [...new Set(apps)].map(async (app) => {
        try {
          const accounts = approvedAccounts(context, app);
          if (!accounts[0]) throw new Error("no approved account can be identified");
          const tools = await listRemoteMcpTools({
            endpoint: MCP_ENDPOINT,
            headers: this.mcpHeaders(context, app, accounts[0].ref, token),
            signal: context.signal,
            fetch: this.dependencies.fetch,
            resolveHostname: this.dependencies.resolveHostname,
          });
          return tools.map((tool) => {
            const flatSelector = accounts.length > 1 ? accountSelector(tool.inputSchema) : null;
            const envelope =
              accounts.length > 1 &&
              (requiresAccountEnvelope(tool.inputSchema) || flatSelector === undefined);
            const unsupported = envelope && !supportsAccountEnvelope(tool.inputSchema);
            const catalogUnsupported =
              accounts.length > 1 && lacksCatalogValidation(tool.inputSchema);
            const selector = unsupported ? undefined : envelope ? ACCOUNT_ARGUMENT : flatSelector;
            return {
              ...tool,
              inputSchema: withAccountChoice(
                tool.inputSchema,
                accounts,
                selector ?? null,
                envelope,
              ),
              route: {
                connectorId: "pipedream",
                resourceId: app,
                toolName: tool.name,
                catalogGroup: app,
                pipedreamAccountSelector: selector ?? null,
                ...(accounts.length === 1 ? { pipedreamSingletonConnectionId: accounts[0]!.id } : {}),
                ...(selector === undefined ? { pipedreamAccountSelectorUnsupported: true } : {}),
                ...(envelope && !unsupported ? { pipedreamAccountEnvelope: true } : {}),
                ...(catalogUnsupported ? { pipedreamAccountCatalogUnsupported: true } : {}),
              },
            };
          });
        } catch (error) {
          // A single unavailable app must not hide tools from other connections.
          getLogger().error(
            `pipedream discovery failed for app ${app}:`,
            sanitizeConnectorError(error),
          );
          return [];
        }
      }),
    );
    return groups.flat();
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.allTools(context);
    if (tools.length <= DIRECT_TOOL_LIMIT) return tools;
    return lazyCatalogTools(
      catalogToolPrefix("pipedream"),
      "pipedream",
      "app",
      catalogEntries(tools),
    );
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    // Wrappers have no resourceId; real tools always do.
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    const entries = catalogEntries(await this.allTools(context));
    const target = loadCatalogEntry(entries, call.args).tool.route;
    if (target?.pipedreamAccountSelectorUnsupported || target?.pipedreamAccountCatalogUnsupported)
      throw new Error("This tool's schema does not support selecting between connected accounts.");
    return resolveCatalogCall(call, entries);
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (isLazyCatalogControlRoute(call.route)) {
      try {
        const entries = catalogEntries(await this.allTools(context));
        const target =
          call.route?.toolName === CATALOG_EXECUTE
            ? loadCatalogEntry(entries, call.args).tool.route
            : undefined;
        if (
          target?.pipedreamAccountSelectorUnsupported ||
          target?.pipedreamAccountCatalogUnsupported
        ) {
          yield {
            type: "error",
            message: "This tool's schema does not support selecting between connected accounts.",
          };
          return;
        }
        yield* executeLazyCatalogControl(call, entries, (resolved) =>
          this.execute(resolved, context),
        );
      } catch (error) {
        yield { type: "error", message: sanitizeConnectorError(error) };
      }
      return;
    }
    const app = call.route?.resourceId;
    if (!app) {
      yield { type: "error", message: "Pipedream app route is missing" };
      return;
    }
    let token: string | undefined;
    let toolDispatched = false;
    try {
      const accounts = approvedAccounts(context, app);
      let selector = call.route?.pipedreamAccountSelector;
      let unsupportedSelector = call.route?.pipedreamAccountSelectorUnsupported === true;
      let envelope = call.route?.pipedreamAccountEnvelope === true;
      if (
        selector === undefined &&
        accounts.length === 1 &&
        Object.hasOwn(call.args, ACCOUNT_ARGUMENT)
      ) {
        yield {
          type: "error",
          message: "Refresh this tool to verify its connected account before running it.",
        };
        return;
      }
      if (selector === undefined && accounts.length > 1) {
        // Older in-flight routes do not say whether the provider owns the old chooser name.
        const tool = (await this.allTools(context)).find(
          (candidate) =>
            candidate.route?.resourceId === app &&
            candidate.route.toolName === call.route?.toolName,
        );
        if (!tool) throw new Error("Account selection could not be refreshed for this tool.");
        selector = tool.route?.pipedreamAccountSelector;
        unsupportedSelector = tool.route?.pipedreamAccountSelectorUnsupported === true;
        envelope = tool.route?.pipedreamAccountEnvelope === true;
      }
      if (unsupportedSelector && accounts.length > 1) {
        yield {
          type: "error",
          message: "This tool's schema does not support selecting between connected accounts.",
        };
        return;
      }
      if (selector === null && accounts.length > 1) {
        yield {
          type: "error",
          message: "Connected accounts changed. Refresh this tool and select an account.",
        };
        return;
      }
      const chosen = typeof selector === "string" ? call.args[selector] : undefined;
      const matchingAccounts = typeof selector === "string"
        ? accounts.filter(({ id, ref }) => id === chosen || (context.legacyPipedreamWatchSelection === true && ref === chosen))
        : [];
      const account =
        typeof selector === "string"
          ? matchingAccounts.length === 1 ? matchingAccounts[0] : undefined
          : accounts.length === 1
            ? accounts[0]
            : undefined;
      if (!account) {
        yield {
          type: "error",
          message: accounts.length
            ? `Set ${selector ?? ACCOUNT_ARGUMENT} to one of the accounts connected for ${app}.`
            : `No connected ${app} account can be identified. Reconnect ${app}.`,
        };
        return;
      }
      let args: Record<string, unknown>;
      if (envelope) {
        const nested = call.args.arguments;
        if (
          !nested ||
          typeof nested !== "object" ||
          Array.isArray(nested) ||
          Object.keys(call.args).some((key) => key !== selector && key !== "arguments")
        ) {
          yield {
            type: "error",
            message: "Refresh this tool and provide its account and arguments.",
          };
          return;
        }
        args = nested as Record<string, unknown>;
      } else {
        args = { ...call.args };
        if (typeof selector === "string") delete args[selector];
      }
      token = await this.token();
      const result = await callRemoteMcpTool(
        {
          endpoint: MCP_ENDPOINT,
          headers: this.mcpHeaders(context, app, account.ref, token),
          signal: context.signal,
          fetch: this.dependencies.fetch,
          resolveHostname: this.dependencies.resolveHostname,
          onToolDispatch: () => { toolDispatched = true; },
        },
        call.route?.toolName ?? call.tool,
        args,
      );
      const redacted = redactConnectorPayloadStrict(result, [token, this.config.clientSecret]);
      const explicitFailure = result && typeof result === "object" &&
        !Array.isArray(result) && "isError" in result && result.isError === true;
      yield {
        type: "result",
        data: explicitFailure && redacted && typeof redacted === "object" && !Array.isArray(redacted)
          ? { ...redacted, isError: true }
          : redacted,
      };
    } catch (error) {
      yield {
        type: "error",
        ...(toolDispatched ? { outcome: "unknown" as const } : {}),
        message: toolDispatched
          ? "The Pipedream operation may have run, but its outcome could not be verified."
          : sanitizeConnectorError(
              error,
              [token, this.config.clientSecret].filter((value): value is string => Boolean(value)),
            ),
      };
    }
  }

  async begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }> {
    const response = await this.request<{ connect_link_url: string }>(
      `/v1/connect/${encodeURIComponent(this.config.projectId)}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          external_user_id: this.externalUserId(context),
          success_redirect_uri: request.redirectUrl,
          error_redirect_uri: request.redirectUrl,
          scope: "connect:accounts:read connect:accounts:write",
        }),
      },
      context.signal,
    );
    const url = securePipedreamConnectUrl(response.connect_link_url);
    url.searchParams.set("app", request.provider);
    return { authorizationUrl: url.toString(), state: request.provider };
  }

  async complete(request: { state: string }): Promise<{ connectionRef: string }> {
    return { connectionRef: request.state };
  }

  /**
   * Prefer a concrete Pipedream account id over the app slug so multi-account
   * revoke can target one authorization. spaceId is required for the hashed
   * external user id Pipedream uses to scope accounts.
   */
  async resolveConnectedAccountId(
    userId: string,
    slug: string,
    currentRef: string | null | undefined,
    excludeIds: string[] = [],
    spaceId?: string,
  ): Promise<string | undefined> {
    const excluded = new Set(excludeIds.filter(Boolean));
    const current = currentRef?.trim() || undefined;
    if (!spaceId) {
      return current && current !== slug && !excluded.has(current) ? current : undefined;
    }
    // Concrete account ids are already authoritative; do not reassign them.
    if (current && current !== slug) {
      return excluded.has(current) ? undefined : current;
    }
    const context = {
      userId,
      spaceId,
      signal: AbortSignal.timeout(30_000),
    } as AdapterContext;
    const accounts = await this.accounts(context, slug);
    const ids = accounts
      .filter((account) => account.healthy !== false && account.dead !== true)
      .map((account) => account.id)
      .filter(Boolean);
    return ids.find((id) => !excluded.has(id));
  }

  async connectionReady(context: AdapterContext, externalId: string): Promise<boolean> {
    const accounts = await this.accounts(context, externalId);
    return accounts.some(
      (account) =>
        account.app?.name_slug === externalId && account.healthy !== false && account.dead !== true,
    );
  }

  async revoke(externalId: string, context: AdapterContext): Promise<void> {
    let accounts: PipedreamAccount[];
    try {
      accounts = await this.accounts(context);
    } catch (error) {
      // Listing failed before any DELETE — mark so callers can restore local retry state.
      if (error && typeof error === "object") {
        (error as { remoteRevokePreDelete?: boolean }).remoteRevokePreDelete = true;
      }
      throw error;
    }
    const targets = accounts.filter(
      (account) => account.id === externalId || account.app?.name_slug === externalId,
    );
    await Promise.all(
      targets.map((account) =>
        this.request(
          `/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts/${encodeURIComponent(account.id)}`,
          { method: "DELETE" },
          context.signal,
        ),
      ),
    );
  }

  /**
   * Delete remote accounts for `slug` that no local row still references. Used when a
   * begin loses a race to revoke and only the app slug is available — never revoke by
   * slug alone, or every sibling authorization would be deleted.
   */
  async revokeUnreferencedAccounts(
    slug: string,
    keepAccountIds: string[],
    context: AdapterContext,
  ): Promise<void> {
    const keep = new Set(keepAccountIds.filter(Boolean));
    const accounts = await this.accounts(context, slug);
    const orphans = accounts.filter(
      (account) =>
        account.app?.name_slug === slug &&
        account.healthy !== false &&
        account.dead !== true &&
        !keep.has(account.id),
    );
    await Promise.all(
      orphans.map((account) =>
        this.request(
          `/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts/${encodeURIComponent(account.id)}`,
          { method: "DELETE" },
          context.signal,
        ),
      ),
    );
  }

  /** Pipedream keys connected accounts by this stateless ID; changing it orphans them. */
  private externalUserId(context: AdapterContext): string {
    return `rkz_${createHmac("sha256", this.config.identitySecret)
      .update(`${context.spaceId}:${context.userId}`)
      .digest("hex")}`;
  }

  private mcpHeaders(
    context: AdapterContext,
    app: string,
    accountId: string,
    accessToken: string,
  ): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      "x-pd-project-id": this.config.projectId,
      "x-pd-environment": this.config.environment,
      "x-pd-external-user-id": this.externalUserId(context),
      "x-pd-app-slug": app,
      "x-pd-account-id": accountId,
    };
  }

  private async apps(): Promise<PipedreamApp[]> {
    if (this.directory && this.directory.expiresAt > Date.now()) return this.directory.value;
    if (this.directoryRequest) return this.directoryRequest;
    this.directoryRequest = this.loadApps();
    try {
      return await this.directoryRequest;
    } finally {
      this.directoryRequest = undefined;
    }
  }

  private async loadApps(): Promise<PipedreamApp[]> {
    const apps: PipedreamApp[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: "100", has_actions: "true" });
      if (after) query.set("after", after);
      const response = await this.request<{
        data?: PipedreamApp[];
        page_info?: { end_cursor?: string };
      }>(`/v1/connect/apps?${query}`);
      apps.push(...(response.data ?? []));
      after = response.page_info?.end_cursor;
      if (!after || apps.length >= 5_000) break;
    }
    this.directory = { value: apps, expiresAt: Date.now() + DIRECTORY_TTL_MS };
    return apps;
  }

  private async accounts(context: AdapterContext, app?: string): Promise<PipedreamAccount[]> {
    return collectPages(async (after) => {
      const query = new URLSearchParams({
        external_user_id: this.externalUserId(context),
        limit: "100",
      });
      if (app) query.set("app", app);
      if (after) query.set("after", after);
      const response = await this.request<{
        data?: PipedreamAccount[];
        page_info?: { end_cursor?: string };
      }>(
        `/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts?${query}`,
        {},
        context.signal,
      );
      return { items: response.data ?? [], cursor: response.page_info?.end_cursor };
    }, 20);
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const token = await this.token();
    const requestAbort = combineSignals(signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    const response = await (this.dependencies.fetch ?? globalThis.fetch)(`${API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-pd-environment": this.config.environment,
        ...init.headers,
      },
      signal: requestAbort,
    });
    if (response.status === 401) this.accessToken = undefined;
    const body = await readPipedreamBody(response, requestAbort);
    if (!response.ok) {
      throw new Error(
        sanitizeConnectorError(`Pipedream returned HTTP ${response.status}: ${body}`, [token]),
      );
    }
    return (body ? JSON.parse(body) : {}) as T;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    if (this.accessTokenRequest) return this.accessTokenRequest;
    this.accessTokenRequest = this.fetchToken();
    try {
      return await this.accessTokenRequest;
    } finally {
      this.accessTokenRequest = undefined;
    }
  }

  private async fetchToken(): Promise<string> {
    const requestAbort = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await (this.dependencies.fetch ?? globalThis.fetch)(
      `${API_BASE}/v1/oauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          scope: "connect:*",
        }),
        signal: requestAbort,
      },
    );
    const text = await readPipedreamBody(response, requestAbort);
    const body = (response.ok && text ? JSON.parse(text) : {}) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !body.access_token) {
      throw new Error(`Pipedream authentication failed: ${body.error ?? response.status}`);
    }
    this.accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3_600) * 1_000,
    };
    return body.access_token;
  }
}

/**
 * The accounts this workspace approved for `app`, so Pipedream never picks one
 * itself. A row holding only the app slug cannot name its account and is skipped:
 * the run context omits revoked and pending rows, so it cannot tell which remote
 * account such a row stands for.
 */
function approvedAccounts(context: AdapterContext, app: string): ApprovedAccount[] {
  const approved = new Map<string, ApprovedAccount>();
  const rows = [...(context.connectedConnections ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  for (const connection of rows) {
    if (connection.connectorId !== "pipedream" || connection.externalId !== app) continue;
    const ref = connection.providerRef?.trim();
    if (ref && ref !== app && !approved.has(ref))
      approved.set(ref, { id: connection.id, ref, label: connection.displayName });
  }
  return [...approved.values()];
}

/** With several approved accounts the model must name one; with one there is nothing to choose. */
function requiresAccountEnvelope(schema: Record<string, unknown>): boolean {
  const keywords = [
    "maxProperties",
    "minProperties",
    "propertyNames",
    "dependencies",
    "dependentRequired",
    "dependentSchemas",
    "patternProperties",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
  ];
  let node: unknown = schema;
  const seen = new Set<object>();
  while (node && typeof node === "object" && !Array.isArray(node) && !seen.has(node)) {
    seen.add(node);
    const current = node as Record<string, unknown>;
    if (keywords.some((key) => Object.hasOwn(current, key))) return true;
    if (current.$ref === undefined) return false;
    if (typeof current.$ref !== "string" || !current.$ref.startsWith("#/")) return true;
    node = schema;
    for (const part of current.$ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) return true;
      node = (node as Record<string, unknown>)[key];
    }
  }
  return true;
}

function supportsAccountEnvelope(schema: Record<string, unknown>): boolean {
  const pending: unknown[] = [schema];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (seen.size > 10_000) return false;
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    const node = value as Record<string, unknown>;
    if (node.$ref !== undefined) return false;
    if (
      node.patternProperties &&
      typeof node.patternProperties === "object" &&
      !Array.isArray(node.patternProperties)
    ) {
      if (node.additionalProperties === false) return false;
      const patterns = Object.keys(node.patternProperties);
      if (patterns.length > 256 || patterns.some((pattern) => !safeAccountPattern(pattern)))
        return false;
    }
    for (const child of schemaChildren(node)) pending.push(child);
  }
  return true;
}

function lacksCatalogValidation(schema: Record<string, unknown>): boolean {
  const pending: unknown[] = [schema];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (seen.size > 10_000) return true;
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    const node = value as Record<string, unknown>;
    if (
      node.dependentRequired !== undefined ||
      node.dependentSchemas !== undefined ||
      node.unevaluatedProperties !== undefined
    )
      return true;
    if (node.$ref !== undefined) {
      const reference = localSchemaReference(schema, node.$ref);
      if (!reference.found) return true;
      pending.push(reference.value);
    }
    for (const child of schemaChildren(node)) pending.push(child);
  }
  return false;
}

function localSchemaReference(
  schema: Record<string, unknown>,
  reference: unknown,
): { found: true; value: unknown } | { found: false } {
  if (reference === "#") return { found: true, value: schema };
  if (typeof reference !== "string" || !reference.startsWith("#/")) return { found: false };
  let value: unknown = schema;
  for (const part of reference.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return { found: false };
    value = (value as Record<string, unknown>)[key];
  }
  return { found: true, value };
}

/** JSON values in default, const, enum and examples are not schemas. */
function schemaChildren(node: Record<string, unknown>): unknown[] {
  const children: unknown[] = [];
  for (const key of [
    "additionalProperties",
    "unevaluatedProperties",
    "propertyNames",
    "items",
    "contains",
    "additionalItems",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
    "allOf",
    "anyOf",
    "oneOf",
    "prefixItems",
  ])
    if (node[key] !== undefined) children.push(node[key]);
  for (const key of ["properties", "patternProperties", "dependentSchemas", "dependencies"]) {
    const map = node[key];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const child of Object.values(map)) {
      if (child && typeof child === "object" && !Array.isArray(child)) children.push(child);
    }
  }
  return children;
}

function accountSelector(schema: Record<string, unknown>): string | undefined {
  const names = new Set<string>();
  const patterns: Array<(name: string) => boolean> = [];
  const pending: unknown[] = [schema];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (seen.size > 10_000) return undefined;
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    const node = value as Record<string, unknown>;
    // Adding a root property cannot make a closed composed subschema accept it.
    if (
      node !== schema &&
      (node.additionalProperties === false || node.unevaluatedProperties === false)
    )
      return undefined;
    if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties))
      for (const name of Object.keys(node.properties)) names.add(name);
    if (Array.isArray(node.required))
      for (const name of node.required) if (typeof name === "string") names.add(name);
    if (
      node.patternProperties &&
      typeof node.patternProperties === "object" &&
      !Array.isArray(node.patternProperties)
    ) {
      for (const pattern of Object.keys(node.patternProperties)) {
        if (patterns.length >= 256) return undefined;
        const matches = safeAccountPattern(pattern);
        if (!matches) return undefined;
        patterns.push(matches);
      }
    }
    for (const key of ["allOf", "anyOf", "oneOf", "not", "if", "then", "else"])
      if (node[key]) pending.push(node[key]);
    for (const key of ["dependentSchemas", "dependencies"]) {
      const dependencies = node[key];
      if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies))
        for (const dependency of Object.values(dependencies))
          if (dependency && typeof dependency === "object" && !Array.isArray(dependency))
            pending.push(dependency);
    }
    if (typeof node.$ref === "string") {
      if (node.$ref === "#") {
        pending.push(schema);
        continue;
      }
      if (!node.$ref.startsWith("#/")) return undefined;
      let target: unknown = schema;
      for (const part of node.$ref.slice(2).split("/")) {
        const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!target || typeof target !== "object" || !Object.hasOwn(target, key)) return undefined;
        target = (target as Record<string, unknown>)[key];
      }
      pending.push(target);
    }
  }
  for (let index = 0; index < 128; index += 1) {
    const name =
      index === 0
        ? ACCOUNT_ARGUMENT
        : index === 1
          ? "rakazo_connected_account"
          : `rakazo_connected_account_${index}`;
    if (!names.has(name) && !patterns.some((matches) => matches(name))) return name;
  }
  return undefined;
}

/** Never execute provider-supplied regular expressions in the application process. */
function safeAccountPattern(pattern: string): ((name: string) => boolean) | undefined {
  if (pattern.length > 128) return undefined;
  const starts = pattern.startsWith("^");
  const ends = pattern.endsWith("$");
  let literal = pattern.slice(starts ? 1 : 0, ends ? -1 : undefined);
  const leadingAny = literal.startsWith(".*");
  if (leadingAny) literal = literal.slice(2);
  const trailingAny = literal.endsWith(".*");
  if (trailingAny) literal = literal.slice(0, -2);
  if (!literal && (leadingAny || trailingAny)) return () => true;
  if (!/^[A-Za-z0-9_-]+$/.test(literal)) return undefined;
  if (starts && !leadingAny && ends && !trailingAny) return (name) => name === literal;
  if (starts && !leadingAny) return (name) => name.startsWith(literal);
  if (ends && !trailingAny) return (name) => name.endsWith(literal);
  return (name) => name.includes(literal);
}

function withAccountChoice(
  schema: Record<string, unknown>,
  accounts: ApprovedAccount[],
  selector: string | null,
  envelope: boolean,
): Record<string, unknown> {
  if (!selector) return schema;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const choice = {
    type: "string",
    enum: accounts.map(({ id }) => id),
    description: `Connected account to use: ${accounts
      .map(({ id, label }) => `${id} = ${JSON.stringify(label)}`)
      .join(", ")}`,
  };
  if (envelope) {
    return {
      type: "object",
      properties: { [selector]: choice, arguments: schema },
      required: [selector, "arguments"],
      additionalProperties: false,
    };
  }
  return {
    ...schema,
    properties: {
      ...properties,
      [selector]: choice,
    },
    required: [...required, selector],
  };
}

async function readPipedreamBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_PIPEDREAM_RESPONSE_BYTES) {
    const cancel = response.body?.cancel() ?? Promise.resolve();
    // A hanging cancel must not outlive the shared deadline.
    await withAbort(
      cancel.catch(() => undefined),
      signal,
    ).catch(() => undefined);
    throw new Error("Pipedream response is too large.");
  }
  try {
    const bytes = await readBodyCapped(response, MAX_PIPEDREAM_RESPONSE_BYTES, signal);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error("Pipedream response is too large.");
    }
    throw error;
  }
}
