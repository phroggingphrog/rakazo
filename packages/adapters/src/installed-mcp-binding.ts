import type { InstalledMcpBinding } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";

type Client = Pick<PrismaClient, "$queryRaw">;
type Scope = { spaceId: string; userId: string };
type Install = {
  id: string;
  spaceId: string;
  allSpaces: boolean;
  secretId: string | null;
  config: unknown;
  generation: string;
};

function usesCredential(value: unknown): boolean {
  const config =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const auth = config?.auth;
  const type =
    auth === undefined
      ? "none"
      : auth && typeof auth === "object" && !Array.isArray(auth)
        ? ((auth as Record<string, unknown>).type ?? "none")
        : undefined;
  return type !== "none";
}

/** Read an owner-scoped identity without retaining source, credential or secret contents. */
export async function captureInstalledMcpBinding(
  db: Client,
  scope: Scope,
  installId: string,
): Promise<InstalledMcpBinding | undefined> {
  const installs = await db.$queryRaw<Install[]>`
    SELECT id, "spaceId", "allSpaces", "secretId", config, "sourceGeneration"::text AS generation
    FROM capability_installs WHERE id = ${installId} AND "userId" = ${scope.userId} AND kind = 'mcp'`;
  const install = installs[0];
  if (!install || !positiveGeneration(install.generation)) return undefined;
  const availability =
    install.spaceId === scope.spaceId ? "home" : install.allSpaces ? "all" : "space";
  let spaceGeneration: string | null = null;
  if (availability === "space") {
    const spaces = await db.$queryRaw<Array<{ generation: string }>>`
      SELECT "availabilityGeneration"::text AS generation FROM capability_install_spaces
      WHERE "installId" = ${installId} AND "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId}`;
    spaceGeneration = spaces[0]?.generation ?? null;
    if (!positiveGeneration(spaceGeneration)) return undefined;
  }
  let secretGeneration: string | null = null;
  const secretUsed = usesCredential(install.config);
  if (secretUsed && install.secretId) {
    const secrets = await db.$queryRaw<Array<{ generation: string }>>`
      SELECT "credentialGeneration"::text AS generation FROM secrets
      WHERE id = ${install.secretId} AND "userId" = ${scope.userId}
        AND ("spaceId" = ${scope.spaceId} OR "spaceId" IS NULL)`;
    secretGeneration = secrets[0]?.generation ?? null;
    if (!positiveGeneration(secretGeneration)) return undefined;
  }
  return {
    version: 1,
    installId,
    sourceGeneration: install.generation,
    availability,
    spaceGeneration,
    secretUsed,
    secretId: install.secretId,
    secretGeneration,
    credentialFingerprint: null,
  };
}

function positiveGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

export function installedMcpBinding(value: unknown): InstalledMcpBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  if (
    Object.keys(b).some(
      (key) =>
        ![
          "version",
          "installId",
          "sourceGeneration",
          "availability",
          "spaceGeneration",
          "secretUsed",
          "secretId",
          "secretGeneration",
          "credentialFingerprint",
        ].includes(key),
    ) ||
    b.version !== 1 ||
    typeof b.installId !== "string" ||
    !b.installId ||
    !positiveGeneration(b.sourceGeneration) ||
    !["home", "all", "space"].includes(String(b.availability)) ||
    (b.availability === "space"
      ? !positiveGeneration(b.spaceGeneration)
      : b.spaceGeneration !== null) ||
    typeof b.secretUsed !== "boolean" ||
    (b.credentialFingerprint !== null &&
      (typeof b.credentialFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(b.credentialFingerprint))) ||
    (!b.secretUsed && b.credentialFingerprint !== null) ||
    (b.secretId !== null && (typeof b.secretId !== "string" || !b.secretId)) ||
    (b.secretUsed && b.secretId !== null
      ? !positiveGeneration(b.secretGeneration)
      : b.secretGeneration !== null)
  )
    return undefined;
  return b as unknown as InstalledMcpBinding;
}

export function sameInstalledMcpBinding(
  a: InstalledMcpBinding | undefined,
  b: InstalledMcpBinding | undefined,
): boolean {
  return Boolean(
    a &&
      b &&
      a.installId === b.installId &&
      a.sourceGeneration === b.sourceGeneration &&
      a.availability === b.availability &&
      a.spaceGeneration === b.spaceGeneration &&
      a.secretUsed === b.secretUsed &&
      a.secretId === b.secretId &&
      a.secretGeneration === b.secretGeneration &&
      a.credentialFingerprint === b.credentialFingerprint,
  );
}

/** Hold the same source, assignment and credential stable through the effect claim. */
export async function lockInstalledMcpBinding(
  tx: Prisma.TransactionClient,
  scope: Scope,
  binding: InstalledMcpBinding,
): Promise<boolean> {
  const installs = await tx.$queryRaw<Install[]>`
    SELECT id, "spaceId", "allSpaces", "secretId", config, "sourceGeneration"::text AS generation
    FROM capability_installs WHERE id = ${binding.installId} AND "userId" = ${scope.userId}
      AND kind = 'mcp' AND "sourceGeneration"::text = ${binding.sourceGeneration} FOR SHARE`;
  const install = installs[0];
  if (
    !install ||
    install.secretId !== binding.secretId ||
    usesCredential(install.config) !== binding.secretUsed
  )
    return false;
  if (binding.availability === "home" && install.spaceId !== scope.spaceId) return false;
  if (binding.availability === "all" && (install.spaceId === scope.spaceId || !install.allSpaces))
    return false;
  if (binding.availability === "space") {
    if (install.spaceId === scope.spaceId || install.allSpaces) return false;
    const spaces = await tx.$queryRaw<Array<{ generation: string }>>`
      SELECT "availabilityGeneration"::text AS generation FROM capability_install_spaces
      WHERE "installId" = ${binding.installId} AND "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId}
        AND "availabilityGeneration"::text = ${binding.spaceGeneration} FOR SHARE`;
    if (spaces.length !== 1) return false;
  }
  if (binding.secretUsed && binding.secretId) {
    const secrets = await tx.$queryRaw<Array<{ generation: string }>>`
      SELECT "credentialGeneration"::text AS generation FROM secrets
      WHERE id = ${binding.secretId} AND "userId" = ${scope.userId}
        AND ("spaceId" = ${scope.spaceId} OR "spaceId" IS NULL)
        AND "credentialGeneration"::text = ${binding.secretGeneration} FOR SHARE`;
    if (secrets.length !== 1) return false;
  }
  return true;
}
