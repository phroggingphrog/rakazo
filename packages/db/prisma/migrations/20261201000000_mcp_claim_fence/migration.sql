-- Existing token rows have unknown provenance and are not automatically recovered.
ALTER TABLE "external_effects" ADD COLUMN "dispatchClaimFence" INTEGER;
