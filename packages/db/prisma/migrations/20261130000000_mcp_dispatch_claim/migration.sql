-- Drain old workers before enabling tokenized MCP dispatch: they do not enforce this token.
ALTER TABLE "external_effects" ADD COLUMN "dispatchClaimToken" TEXT;
