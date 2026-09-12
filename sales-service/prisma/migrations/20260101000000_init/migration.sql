-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'VEHICLE_RESERVED', 'CUSTOMER_VALIDATED', 'AWAITING_PAYMENT', 'PAID', 'SALE_CONFIRMED', 'COMPLETED', 'COMPENSATING', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CancellationReason" AS ENUM ('CUSTOMER_GAVE_UP', 'PAYMENT_TIMEOUT', 'PAYMENT_REFUSED', 'VEHICLE_UNAVAILABLE', 'CUSTOMER_NOT_ELIGIBLE', 'SYSTEM_FAILURE');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "amount_in_cents" INTEGER,
    "reservation_id" UUID,
    "reservation_expires_at" TIMESTAMPTZ(3),
    "payment_charge_id" VARCHAR(100),
    "payment_code" VARCHAR(512),
    "saga_task_token" VARCHAR(1024),
    "payment_code_expires_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "cancellation_reason" "CancellationReason",
    "cancellation_detail" VARCHAR(500),
    "timeline" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "processed_webhooks" (
    "id" VARCHAR(200) NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_payment_charge_id_key" ON "orders"("payment_charge_id");

-- CreateIndex
CREATE INDEX "orders_status_payment_code_expires_at_idx" ON "orders"("status", "payment_code_expires_at");

-- CreateIndex
CREATE INDEX "orders_customer_id_created_at_idx" ON "orders"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_vehicle_id_status_idx" ON "orders"("vehicle_id", "status");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

