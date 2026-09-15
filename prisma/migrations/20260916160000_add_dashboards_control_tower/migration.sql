-- CreateTable
CREATE TABLE "DashboardSnapshot" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CtCaseVariant" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "processKey" TEXT NOT NULL,
    "processVersion" INTEGER NOT NULL,
    "variantHash" TEXT NOT NULL,
    "sequence" TEXT[],
    "stepCount" INTEGER NOT NULL,
    "durationMin" INTEGER,
    "conformant" BOOLEAN NOT NULL,
    "violations" JSONB,
    "reworkCount" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtCaseVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CtStepMetricDaily" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "processKey" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "areaKey" TEXT NOT NULL,
    "started" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "p50ActiveMin" DOUBLE PRECISION,
    "p90ActiveMin" DOUBLE PRECISION,
    "avgActiveMin" DOUBLE PRECISION,
    "p50WaitMin" DOUBLE PRECISION,
    "p90WaitMin" DOUBLE PRECISION,
    "breached" INTEGER NOT NULL DEFAULT 0,
    "reworked" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtStepMetricDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CtHandoffDaily" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "fromAreaKey" TEXT NOT NULL,
    "toAreaKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "p50ResponseMin" DOUBLE PRECISION,
    "p90ResponseMin" DOUBLE PRECISION,
    "expired" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtHandoffDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CtBlockCauseDaily" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "causeType" TEXT NOT NULL,
    "causeKey" TEXT NOT NULL,
    "causeLabel" TEXT NOT NULL,
    "blocks" INTEGER NOT NULL DEFAULT 0,
    "waitMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtBlockCauseDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CtProjectionWatermark" (
    "key" TEXT NOT NULL,
    "lastEventId" BIGINT NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "lastDurationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtProjectionWatermark_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "CtGraphScene" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "perspectiveKey" TEXT NOT NULL,
    "roots" JSONB NOT NULL,
    "filters" JSONB,
    "layout" JSONB,
    "at" TIMESTAMP(3),
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtGraphScene_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DashboardSnapshot_scopeType_scopeKey_key" ON "DashboardSnapshot"("scopeType", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "CtCaseVariant_caseId_key" ON "CtCaseVariant"("caseId");

-- CreateIndex
CREATE INDEX "CtCaseVariant_processKey_variantHash_idx" ON "CtCaseVariant"("processKey", "variantHash");

-- CreateIndex
CREATE INDEX "CtCaseVariant_processKey_processVersion_idx" ON "CtCaseVariant"("processKey", "processVersion");

-- CreateIndex
CREATE INDEX "CtStepMetricDaily_processKey_day_idx" ON "CtStepMetricDaily"("processKey", "day");

-- CreateIndex
CREATE INDEX "CtStepMetricDaily_areaKey_day_idx" ON "CtStepMetricDaily"("areaKey", "day");

-- CreateIndex
CREATE UNIQUE INDEX "CtStepMetricDaily_day_processKey_stepKey_key" ON "CtStepMetricDaily"("day", "processKey", "stepKey");

-- CreateIndex
CREATE INDEX "CtHandoffDaily_fromAreaKey_day_idx" ON "CtHandoffDaily"("fromAreaKey", "day");

-- CreateIndex
CREATE INDEX "CtHandoffDaily_toAreaKey_day_idx" ON "CtHandoffDaily"("toAreaKey", "day");

-- CreateIndex
CREATE UNIQUE INDEX "CtHandoffDaily_day_fromAreaKey_toAreaKey_kind_key" ON "CtHandoffDaily"("day", "fromAreaKey", "toAreaKey", "kind");

-- CreateIndex
CREATE INDEX "CtBlockCauseDaily_causeType_day_idx" ON "CtBlockCauseDaily"("causeType", "day");

-- CreateIndex
CREATE UNIQUE INDEX "CtBlockCauseDaily_day_causeType_causeKey_key" ON "CtBlockCauseDaily"("day", "causeType", "causeKey");

-- CreateIndex
CREATE INDEX "CtGraphScene_userId_idx" ON "CtGraphScene"("userId");

-- CreateIndex
CREATE INDEX "CtGraphScene_shared_perspectiveKey_idx" ON "CtGraphScene"("shared", "perspectiveKey");

