-- CreateTable: SalesOrderPackage
CREATE TABLE "SalesOrderPackage" (
    "id" TEXT NOT NULL,
    "zohoPackageId" TEXT NOT NULL,
    "zohoSalesOrderId" TEXT,
    "salesOrderNumber" TEXT,
    "packageNumber" TEXT,
    "packageDate" DATE,
    "shipmentDate" DATE,
    "trackingNumber" TEXT,
    "deliveryMethod" TEXT,
    "status" TEXT,
    "zohoCustomerId" TEXT,
    "customerName" TEXT,
    "totalQuantity" DECIMAL(18,4),
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId" TEXT NOT NULL,
    "normalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrderPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SalesOrderPackageItem
CREATE TABLE "SalesOrderPackageItem" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "zohoLineItemId" TEXT,
    "soLineItemId" TEXT,
    "zohoItemId" TEXT,
    "sku" TEXT,
    "name" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(18,4),
    "unit" TEXT,
    "isInvoiced" BOOLEAN,
    "isComboProduct" BOOLEAN,
    "comboType" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrderPackageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Invoice
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "zohoInvoiceId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "zohoSalesOrderId" TEXT,
    "salesOrderNumber" TEXT,
    "invoiceDate" DATE,
    "dueDate" DATE,
    "status" TEXT,
    "paymentStatus" TEXT,
    "zohoCustomerId" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "zohoSalespersonId" TEXT,
    "salespersonName" TEXT,
    "currencyCode" TEXT,
    "subtotal" DECIMAL(18,4),
    "discountTotal" DECIMAL(18,4),
    "taxTotal" DECIMAL(18,4),
    "shippingCharge" DECIMAL(18,4),
    "adjustment" DECIMAL(18,4),
    "total" DECIMAL(18,4),
    "balance" DECIMAL(18,4),
    "amountPaid" DECIMAL(18,4),
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId" TEXT NOT NULL,
    "normalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable: InvoiceItem
CREATE TABLE "InvoiceItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "zohoLineItemId" TEXT,
    "zohoItemId" TEXT,
    "sku" TEXT,
    "name" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(18,4),
    "unit" TEXT,
    "rate" DECIMAL(18,4),
    "discountAmount" DECIMAL(18,4),
    "taxName" TEXT,
    "taxPercentage" DECIMAL(18,4),
    "taxAmount" DECIMAL(18,4),
    "lineTotal" DECIMAL(18,4),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable: InvoicePayment
CREATE TABLE "InvoicePayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "zohoPaymentId" TEXT,
    "paymentNumber" TEXT,
    "paymentDate" DATE,
    "paymentMode" TEXT,
    "referenceNumber" TEXT,
    "amount" DECIMAL(18,4),
    "customerName" TEXT,
    "zohoCustomerId" TEXT,
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Vendor
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "zohoContactId" TEXT NOT NULL,
    "companyName" TEXT,
    "contactType" TEXT,
    "status" TEXT,
    "paymentTerms" INTEGER,
    "paymentTermsLabel" TEXT,
    "currencyCode" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "primaryContactId" TEXT,
    "billingAddress" JSONB,
    "shippingAddress" JSONB,
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId" TEXT NOT NULL,
    "normalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Product
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "zohoItemId" TEXT NOT NULL,
    "name" TEXT,
    "sku" TEXT,
    "description" TEXT,
    "rate" DECIMAL(18,4),
    "unit" TEXT,
    "productType" TEXT,
    "isComboProduct" BOOLEAN,
    "comboType" TEXT,
    "status" TEXT,
    "stockOnHand" DECIMAL(18,4),
    "reorderLevel" DECIMAL(18,4),
    "currencyCode" TEXT,
    "taxName" TEXT,
    "taxPercentage" DECIMAL(18,4),
    "categoryName" TEXT,
    "brandName" TEXT,
    "manufacturer" TEXT,
    "imageUrl" TEXT,
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId" TEXT NOT NULL,
    "normalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ProductComponent
CREATE TABLE "ProductComponent" (
    "id" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "childItemId" TEXT,
    "childName" TEXT,
    "childSku" TEXT,
    "quantity" DECIMAL(18,4),
    "unit" TEXT,
    "rate" DECIMAL(18,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: SalesOrderPackage
CREATE UNIQUE INDEX "SalesOrderPackage_zohoPackageId_key" ON "SalesOrderPackage"("zohoPackageId");
CREATE INDEX "SalesOrderPackage_zohoSalesOrderId_idx" ON "SalesOrderPackage"("zohoSalesOrderId");
CREATE INDEX "SalesOrderPackage_status_idx" ON "SalesOrderPackage"("status");
CREATE INDEX "SalesOrderPackage_packageNumber_idx" ON "SalesOrderPackage"("packageNumber");

-- CreateIndex: SalesOrderPackageItem
CREATE INDEX "SalesOrderPackageItem_packageId_idx" ON "SalesOrderPackageItem"("packageId");

-- CreateIndex: Invoice
CREATE UNIQUE INDEX "Invoice_zohoInvoiceId_key" ON "Invoice"("zohoInvoiceId");
CREATE INDEX "Invoice_zohoSalesOrderId_idx" ON "Invoice"("zohoSalesOrderId");
CREATE INDEX "Invoice_invoiceNumber_idx" ON "Invoice"("invoiceNumber");
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");
CREATE INDEX "Invoice_zohoCustomerId_idx" ON "Invoice"("zohoCustomerId");
CREATE INDEX "Invoice_invoiceDate_idx" ON "Invoice"("invoiceDate");

-- CreateIndex: InvoiceItem
CREATE INDEX "InvoiceItem_invoiceId_idx" ON "InvoiceItem"("invoiceId");

-- CreateIndex: InvoicePayment
CREATE INDEX "InvoicePayment_invoiceId_idx" ON "InvoicePayment"("invoiceId");
CREATE INDEX "InvoicePayment_zohoPaymentId_idx" ON "InvoicePayment"("zohoPaymentId");
CREATE INDEX "InvoicePayment_paymentDate_idx" ON "InvoicePayment"("paymentDate");

-- CreateIndex: Vendor
CREATE UNIQUE INDEX "Vendor_zohoContactId_key" ON "Vendor"("zohoContactId");
CREATE INDEX "Vendor_companyName_idx" ON "Vendor"("companyName");
CREATE INDEX "Vendor_status_idx" ON "Vendor"("status");
CREATE INDEX "Vendor_email_idx" ON "Vendor"("email");

-- CreateIndex: Product
CREATE UNIQUE INDEX "Product_zohoItemId_key" ON "Product"("zohoItemId");
CREATE INDEX "Product_sku_idx" ON "Product"("sku");
CREATE INDEX "Product_name_idx" ON "Product"("name");
CREATE INDEX "Product_status_idx" ON "Product"("status");
CREATE INDEX "Product_productType_idx" ON "Product"("productType");

-- CreateIndex: ProductComponent
CREATE INDEX "ProductComponent_parentId_idx" ON "ProductComponent"("parentId");

-- AddForeignKey
ALTER TABLE "SalesOrderPackageItem" ADD CONSTRAINT "SalesOrderPackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "SalesOrderPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductComponent" ADD CONSTRAINT "ProductComponent_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
