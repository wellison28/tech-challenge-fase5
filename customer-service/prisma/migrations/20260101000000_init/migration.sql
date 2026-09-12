-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'BLOCKED', 'ANONYMIZED');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('PURCHASE_PROCESSING', 'DOCUMENT_ISSUANCE', 'MARKETING', 'CREDIT_ANALYSIS');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('WEB_FORM', 'MOBILE_APP', 'IN_STORE', 'MIGRATION');

-- CreateEnum
CREATE TYPE "DataAccessAction" AS ENUM ('READ_SENSITIVE', 'READ_MASKED', 'CREATE', 'UPDATE', 'ELIGIBILITY_CHECK', 'EXPORT_FOR_BILLING', 'EXPORT_FOR_DOCUMENTATION', 'DATA_SUBJECT_EXPORT', 'ANONYMIZE', 'CONSENT_CHANGE');

-- CreateEnum
CREATE TYPE "AccessOutcome" AS ENUM ('ALLOWED', 'DENIED');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "status" "CustomerStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "version" INTEGER NOT NULL DEFAULT 1,
    "cpf_blind_index" CHAR(64),
    "email_blind_index" CHAR(64),
    "blind_index_version" INTEGER,
    "pii_ciphertext" TEXT,
    "pii_encrypted_data_key" TEXT,
    "pii_iv" VARCHAR(32),
    "pii_auth_tag" VARCHAR(32),
    "pii_key_id" VARCHAR(200),
    "pii_algorithm" VARCHAR(20),
    "pii_schema_version" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "anonymized_at" TIMESTAMPTZ(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_consents" (
    "customer_id" UUID NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "policy_version" VARCHAR(30) NOT NULL,
    "granted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "source" "ConsentSource" NOT NULL,

    CONSTRAINT "customer_consents_pkey" PRIMARY KEY ("customer_id","purpose")
);

-- CreateTable
CREATE TABLE "data_access_logs" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "actor_id" VARCHAR(200) NOT NULL,
    "actor_type" VARCHAR(10) NOT NULL,
    "actor_roles" TEXT[],
    "action" "DataAccessAction" NOT NULL,
    "purpose" VARCHAR(200) NOT NULL,
    "fields_accessed" TEXT[],
    "outcome" "AccessOutcome" NOT NULL,
    "denial_reason" VARCHAR(300),
    "correlation_id" VARCHAR(100) NOT NULL,
    "source_ip" VARCHAR(45),
    "user_agent" VARCHAR(300),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_cpf_blind_index_key" ON "customers"("cpf_blind_index");

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_blind_index_key" ON "customers"("email_blind_index");

-- CreateIndex
CREATE INDEX "customers_status_created_at_idx" ON "customers"("status", "created_at");

-- CreateIndex
CREATE INDEX "data_access_logs_customer_id_occurred_at_idx" ON "data_access_logs"("customer_id", "occurred_at");

-- CreateIndex
CREATE INDEX "data_access_logs_actor_id_occurred_at_idx" ON "data_access_logs"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "data_access_logs_outcome_occurred_at_idx" ON "data_access_logs"("outcome", "occurred_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "customer_consents" ADD CONSTRAINT "customer_consents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

