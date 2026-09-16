-- Per-policy exception for the global approval deadline. NULL keeps the policy
-- on the Operations configuration default (initially 24 hours).
ALTER TABLE "ApprovalPolicy"
  ADD COLUMN "expiresAfterMinutes" INTEGER;

ALTER TABLE "ApprovalPolicy"
  ADD CONSTRAINT "ApprovalPolicy_expiresAfterMinutes_allowed"
  CHECK (
    "expiresAfterMinutes" IS NULL OR
    "expiresAfterMinutes" IN (30, 60, 120, 360, 720, 1440, 2880, 4320, 10080)
  );
