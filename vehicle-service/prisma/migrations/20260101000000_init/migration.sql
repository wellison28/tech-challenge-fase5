-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'SOLD');

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('FLEX', 'GASOLINE', 'ETHANOL', 'DIESEL', 'ELECTRIC', 'HYBRID');

-- CreateEnum
CREATE TYPE "Transmission" AS ENUM ('MANUAL', 'AUTOMATIC', 'CVT', 'AUTOMATED');

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "vin" VARCHAR(17) NOT NULL,
    "license_plate" VARCHAR(8),
    "brand" VARCHAR(60) NOT NULL,
    "model" VARCHAR(80) NOT NULL,
    "model_year" INTEGER NOT NULL,
    "manufacture_year" INTEGER NOT NULL,
    "color" VARCHAR(40) NOT NULL,
    "mileage_km" INTEGER NOT NULL,
    "fuel_type" "FuelType" NOT NULL,
    "transmission" "Transmission" NOT NULL,
    "price_in_cents" INTEGER NOT NULL,
    "status" "VehicleStatus" NOT NULL DEFAULT 'AVAILABLE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reservation_id" UUID,
    "reservation_customer_id" UUID,
    "reservation_order_id" UUID,
    "reserved_at" TIMESTAMPTZ(3),
    "reservation_expires_at" TIMESTAMPTZ(3),
    "sale_order_id" UUID,
    "sale_customer_id" UUID,
    "sold_at" TIMESTAMPTZ(3),
    "sold_price_in_cents" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "vehicles_vin_key" ON "vehicles"("vin");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_license_plate_key" ON "vehicles"("license_plate");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_sale_order_id_key" ON "vehicles"("sale_order_id");

-- CreateIndex
CREATE INDEX "vehicles_status_price_in_cents_idx" ON "vehicles"("status", "price_in_cents");

-- CreateIndex
CREATE INDEX "vehicles_reservation_expires_at_idx" ON "vehicles"("reservation_expires_at");

-- CreateIndex
CREATE INDEX "vehicles_reservation_order_id_idx" ON "vehicles"("reservation_order_id");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

