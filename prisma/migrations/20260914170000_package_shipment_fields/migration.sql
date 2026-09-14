-- Package: shipment order fields (Zoho "orden de envío"). Additive, all nullable.
-- The carrier, tracking number and delivery date of a shipped package live in
-- Zoho's shipment_order object; these columns let the normalizer keep them.

ALTER TABLE "Package" ADD COLUMN "zohoShipmentId" TEXT;
ALTER TABLE "Package" ADD COLUMN "shipmentNumber" TEXT;
ALTER TABLE "Package" ADD COLUMN "deliveryDate" TIMESTAMP(3);
ALTER TABLE "Package" ADD COLUMN "trackingUrl" TEXT;
ALTER TABLE "Package" ADD COLUMN "notes" TEXT;
