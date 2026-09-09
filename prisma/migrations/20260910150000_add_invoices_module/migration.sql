-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "zohoInvoiceId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "status" TEXT,
    "date" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "zohoCustomerId" TEXT,
    "customerName" TEXT,
    "currencyCode" TEXT,
    "subTotal" DECIMAL(18,4),
    "taxTotal" DECIMAL(18,4),
    "discountTotal" DECIMAL(18,4),
    "shippingCharge" DECIMAL(18,4),
    "total" DECIMAL(18,4),
    "balance" DECIMAL(18,4),
    "salespersonName" TEXT,
    "cfdiUuid" TEXT,
    "cfdiVersion" TEXT,
    "usoCfdi" TEXT,
    "metodoPago" TEXT,
    "formaPago" TEXT,
    "regimenFiscal" TEXT,
    "cfdiExportacion" TEXT,
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId" TEXT NOT NULL,
    "normalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_zohoInvoiceId_key" ON "Invoice"("zohoInvoiceId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_zohoCustomerId_idx" ON "Invoice"("zohoCustomerId");

-- CreateIndex
CREATE INDEX "Invoice_date_idx" ON "Invoice"("date");

-- CreateIndex
CREATE INDEX "Invoice_sourceSnapshotId_idx" ON "Invoice"("sourceSnapshotId");

-- CreateTable
CREATE TABLE "InvoiceItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "zohoItemId" TEXT,
    "name" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(18,4),
    "rate" DECIMAL(18,4),
    "unit" TEXT,
    "lineTotal" DECIMAL(18,4),
    "taxName" TEXT,
    "taxPercentage" DECIMAL(18,4),
    "taxAmount" DECIMAL(18,4),
    "discountAmount" DECIMAL(18,4),
    "zohoSalesOrderId" TEXT,
    "zohoSalesOrderItemId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceItem_invoiceId_idx" ON "InvoiceItem"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceItem_zohoItemId_idx" ON "InvoiceItem"("zohoItemId");

-- CreateIndex
CREATE INDEX "InvoiceItem_zohoSalesOrderId_idx" ON "InvoiceItem"("zohoSalesOrderId");

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE;
