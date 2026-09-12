import { prisma } from '@/lib/prisma';

/**
 * Local-only demo data generator. Fills every module with realistic-looking
 * fake records so the frontend can be reviewed screen by screen without a
 * live Zoho connection. Every record uses a deterministic `demo-*` id, so
 * re-running this wipes and recreates the same dataset (safe to click again).
 *
 * Never runs outside development: guarded both here and in the API route
 * that calls it.
 */
export async function assertDemoSeedAllowed() {
  if (process.env.NEXT_PUBLIC_ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Demo data seeding is disabled (set NEXT_PUBLIC_ALLOW_DEMO_SEED=true locally to enable it)');
  }
}

const SNAPSHOT_ID = 'demo-seed';
const now = () => new Date();

function daysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function daysFromNow(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

export async function clearDemoData() {
  // Cascading deletes on the FK-backed models take care of their children
  // (items, events, messages, recipients, members...).
  await prisma.$transaction([
    prisma.salesOrder.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.contact.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.product.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.package.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.invoice.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.customerPayment.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.purchaseOrder.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.bill.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.vendorCredit.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.notification.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.commConversation.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.commContact.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.commAccount.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.campaign.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.internalChatChannel.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
    prisma.aiConversation.deleteMany({ where: { id: { startsWith: 'demo-' } } }),
  ]);
}

export async function seedDemoData(actorUserId: string) {
  await assertDemoSeedAllowed();
  await clearDemoData();

  // ---------------------------------------------------------------------
  // Contacts (customers + vendors)
  // ---------------------------------------------------------------------
  const customers = [
    {
      id: 'demo-contact-cust-1',
      name: 'Comercializadora del Valle S.A. de C.V.',
      city: 'Ciudad de México',
      state: 'CDMX',
      email: 'compras@comercializadoradelvalle.mx',
      phone: '+52 55 1234 5678',
      status: 'active',
    },
    {
      id: 'demo-contact-cust-2',
      name: 'Ferretería La Unión',
      city: 'Monterrey',
      state: 'Nuevo León',
      email: 'contacto@ferreterialaunion.mx',
      phone: '+52 81 2233 4455',
      status: 'active',
    },
    {
      id: 'demo-contact-cust-3',
      name: 'Grupo Industrial Pacífico',
      city: 'Guadalajara',
      state: 'Jalisco',
      email: 'administracion@gipacifico.mx',
      phone: '+52 33 3344 5566',
      status: 'active',
    },
    {
      id: 'demo-contact-cust-4',
      name: 'Distribuidora Hermanos Torres',
      city: 'Puebla',
      state: 'Puebla',
      email: 'ventas@torresdistribuidora.mx',
      phone: '+52 222 456 7890',
      status: 'active',
    },
    {
      id: 'demo-contact-cust-5',
      name: 'Constructora Nuevo León',
      city: 'Monterrey',
      state: 'Nuevo León',
      email: 'pagos@constructoranl.mx',
      phone: '+52 81 9988 7766',
      status: 'inactive',
    },
  ];

  const vendors = [
    {
      id: 'demo-contact-vend-1',
      name: 'Proveedora Industrial del Norte',
      city: 'Saltillo',
      state: 'Coahuila',
      email: 'ventas@proveedoranorte.mx',
      phone: '+52 844 111 2233',
      status: 'active',
    },
    {
      id: 'demo-contact-vend-2',
      name: 'Materiales y Suministros MX',
      city: 'Querétaro',
      state: 'Querétaro',
      email: 'facturacion@materialesmx.mx',
      phone: '+52 442 555 6677',
      status: 'active',
    },
    {
      id: 'demo-contact-vend-3',
      name: 'Aceros del Bajío',
      city: 'León',
      state: 'Guanajuato',
      email: 'contacto@acerosdelbajio.mx',
      phone: '+52 477 888 9900',
      status: 'active',
    },
  ];

  for (const c of [...customers, ...vendors]) {
    const isVendor = vendors.includes(c as (typeof vendors)[number]);
    await prisma.contact.create({
      data: {
        id: c.id,
        zohoContactId: c.id,
        contactType: isVendor ? 'vendor' : 'customer',
        contactName: c.name,
        companyName: c.name,
        currencyCode: 'MXN',
        paymentTerms: 30,
        paymentTermsLabel: 'Net 30',
        status: c.status,
        outstandingReceivable: isVendor ? 0 : 12500,
        outstandingPayable: isVendor ? 8600 : 0,
        primaryEmail: c.email,
        primaryPhone: c.phone,
        billingCity: c.city,
        billingState: c.state,
        billingCountry: 'México',
        shippingCity: c.city,
        shippingState: c.state,
        shippingCountry: 'México',
        source: 'demo',
        sourceRemoteModifiedAt: now(),
        sourceSnapshotId: SNAPSHOT_ID,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Products
  // ---------------------------------------------------------------------
  const products = [
    { id: 'demo-product-1', name: 'Tornillo hexagonal 1/2"', sku: 'SKU-001', rate: 3.5, stock: 5200 },
    { id: 'demo-product-2', name: 'Lámina galvanizada calibre 22', sku: 'SKU-002', rate: 285.0, stock: 340 },
    { id: 'demo-product-3', name: 'Cable eléctrico THW 10 AWG (m)', sku: 'SKU-003', rate: 18.9, stock: 8000 },
    { id: 'demo-product-4', name: 'Cemento gris 50kg', sku: 'SKU-004', rate: 189.0, stock: 610 },
    { id: 'demo-product-5', name: 'Varilla corrugada 3/8" (6m)', sku: 'SKU-005', rate: 145.0, stock: 1250 },
    { id: 'demo-product-6', name: 'Pintura vinílica blanca 19L', sku: 'SKU-006', rate: 720.0, stock: 95 },
    { id: 'demo-product-7', name: 'Tubo PVC hidráulico 2"', sku: 'SKU-007', rate: 96.5, stock: 430 },
    { id: 'demo-product-8', name: 'Broca para concreto 8mm', sku: 'SKU-008', rate: 24.0, stock: 1800 },
    { id: 'demo-product-9', name: 'Guantes de carnaza (par)', sku: 'SKU-009', rate: 65.0, stock: 900 },
    { id: 'demo-product-10', name: 'Casco de seguridad blanco', sku: 'SKU-010', rate: 180.0, stock: 260 },
  ];

  for (const p of products) {
    await prisma.product.create({
      data: {
        id: p.id,
        zohoItemId: p.id,
        name: p.name,
        sku: p.sku,
        status: 'active',
        productType: 'inventory',
        rate: p.rate,
        unit: 'pza',
        currencyCode: 'MXN',
        taxName: 'IVA 16%',
        taxPercentage: 16,
        isTaxable: true,
        stockOnHand: p.stock,
        availableStock: p.stock,
        reorderLevel: Math.round(p.stock * 0.1),
        purchaseRate: p.rate * 0.7,
        categoryName: 'Materiales de construcción',
        source: 'demo',
        sourceRemoteModifiedAt: now(),
        sourceSnapshotId: SNAPSHOT_ID,
      },
    });
  }

  function lineItems(count: number, offset = 0) {
    const chosen = products.slice(offset, offset + count);
    return chosen.map((p, i) => {
      const quantity = 5 + i * 3;
      const rate = p.rate;
      const lineTotal = Math.round(quantity * rate * 100) / 100;
      return { product: p, quantity, rate, lineTotal };
    });
  }

  function totals(items: ReturnType<typeof lineItems>) {
    const subtotal = items.reduce((sum, it) => sum + it.lineTotal, 0);
    const taxTotal = Math.round(subtotal * 0.16 * 100) / 100;
    const total = Math.round((subtotal + taxTotal) * 100) / 100;
    return { subtotal, taxTotal, total };
  }

  // ---------------------------------------------------------------------
  // Sales Orders
  // ---------------------------------------------------------------------
  const salesOrdersSpec = [
    {
      id: 'demo-so-1',
      number: 'SO-00001',
      customer: customers[0],
      status: 'confirmed',
      paidStatus: 'paid',
      invoicedStatus: 'invoiced',
      shippedStatus: 'shipped',
      daysAgoOrder: 20,
      items: lineItems(3, 0),
    },
    {
      id: 'demo-so-2',
      number: 'SO-00002',
      customer: customers[1],
      status: 'confirmed',
      paidStatus: 'partially_paid',
      invoicedStatus: 'partially_invoiced',
      shippedStatus: 'partially_shipped',
      daysAgoOrder: 12,
      items: lineItems(2, 2),
    },
    {
      id: 'demo-so-3',
      number: 'SO-00003',
      customer: customers[2],
      status: 'draft',
      paidStatus: 'pending',
      invoicedStatus: 'not_invoiced',
      shippedStatus: 'not_shipped',
      daysAgoOrder: 2,
      items: lineItems(2, 4),
    },
    {
      id: 'demo-so-4',
      number: 'SO-00004',
      customer: customers[3],
      status: 'closed',
      paidStatus: 'paid',
      invoicedStatus: 'invoiced',
      shippedStatus: 'delivered',
      daysAgoOrder: 45,
      items: lineItems(3, 5),
    },
    {
      id: 'demo-so-5',
      number: 'SO-00005',
      customer: customers[0],
      status: 'on_hold',
      paidStatus: 'unpaid',
      invoicedStatus: 'not_invoiced',
      shippedStatus: 'pending',
      daysAgoOrder: 5,
      items: lineItems(2, 1),
    },
    {
      id: 'demo-so-6',
      number: 'SO-00006',
      customer: customers[4],
      status: 'void',
      paidStatus: 'unpaid',
      invoicedStatus: 'not_invoiced',
      shippedStatus: 'not_shipped',
      daysAgoOrder: 30,
      items: lineItems(2, 3),
    },
  ];

  for (const so of salesOrdersSpec) {
    const { subtotal, taxTotal, total } = totals(so.items);
    await prisma.salesOrder.create({
      data: {
        id: so.id,
        zohoSalesOrderId: so.id,
        salesOrderNumber: so.number,
        referenceNumber: `REF-${so.number}`,
        orderDate: daysAgo(so.daysAgoOrder),
        createdTime: daysAgo(so.daysAgoOrder),
        status: so.status,
        paidStatus: so.paidStatus,
        invoicedStatus: so.invoicedStatus,
        shippedStatus: so.shippedStatus,
        zohoCustomerId: so.customer.id,
        customerName: so.customer.name,
        customerEmail: so.customer.email,
        customerPhone: so.customer.phone,
        salespersonName: 'Papa',
        paymentMethod: 'Transferencia bancaria',
        deliveryMethod: 'Paquetería',
        locationName: 'Almacén Central',
        shippingCity: so.customer.city,
        shippingState: so.customer.state,
        shippingCountry: 'México',
        currencyCode: 'MXN',
        subtotal,
        taxTotal,
        discountTotal: 0,
        shippingCharge: 0,
        total,
        balance: so.paidStatus === 'paid' ? 0 : total,
        notes: 'Orden de venta generada por el seed de datos demo.',
        sourceRemoteModifiedAt: now(),
        sourceSnapshotId: SNAPSHOT_ID,
        items: {
          create: so.items.map((it, i) => ({
            zohoLineItemId: `${so.id}-item-${i + 1}`,
            zohoItemId: it.product.id,
            sku: it.product.sku,
            name: it.product.name,
            quantity: it.quantity,
            unit: 'pza',
            rate: it.rate,
            taxName: 'IVA 16%',
            taxPercentage: 16,
            taxAmount: Math.round(it.lineTotal * 0.16 * 100) / 100,
            lineTotal: it.lineTotal,
            sortOrder: i,
          })),
        },
      },
    });
  }

  // ---------------------------------------------------------------------
  // Invoices
  // ---------------------------------------------------------------------
  const invoicesSpec = [
    { id: 'demo-inv-1', number: 'INV-00001', customer: customers[0], status: 'paid', daysAgo_: 20, dueInDays: -5, items: lineItems(3, 0) },
    { id: 'demo-inv-2', number: 'INV-00002', customer: customers[1], status: 'sent', daysAgo_: 8, dueInDays: 10, items: lineItems(2, 2) },
    { id: 'demo-inv-3', number: 'INV-00003', customer: customers[2], status: 'overdue', daysAgo_: 40, dueInDays: -15, items: lineItems(2, 4) },
    { id: 'demo-inv-4', number: 'INV-00004', customer: customers[3], status: 'draft', daysAgo_: 1, dueInDays: 30, items: lineItems(2, 6) },
    { id: 'demo-inv-5', number: 'INV-00005', customer: customers[0], status: 'partially_paid', daysAgo_: 15, dueInDays: 5, items: lineItems(3, 1) },
  ];

  for (const inv of invoicesSpec) {
    const { subtotal, taxTotal, total } = totals(inv.items);
    const balance = inv.status === 'paid' ? 0 : inv.status === 'partially_paid' ? Math.round(total * 0.4 * 100) / 100 : total;
    await prisma.invoice.create({
      data: {
        id: inv.id,
        zohoInvoiceId: inv.id,
        invoiceNumber: inv.number,
        status: inv.status,
        date: daysAgo(inv.daysAgo_),
        dueDate: daysFromNow(inv.dueInDays),
        zohoCustomerId: inv.customer.id,
        customerName: inv.customer.name,
        currencyCode: 'MXN',
        subTotal: subtotal,
        taxTotal,
        discountTotal: 0,
        shippingCharge: 0,
        total,
        balance,
        salespersonName: 'Papa',
        billingCity: inv.customer.city,
        billingState: inv.customer.state,
        billingCountry: 'México',
        shippingCity: inv.customer.city,
        shippingState: inv.customer.state,
        shippingCountry: 'México',
        referenceNumber: `REF-${inv.number}`,
        notes: 'Factura generada por el seed de datos demo.',
        sourceRemoteModifiedAt: now(),
        sourceSnapshotId: SNAPSHOT_ID,
        items: {
          create: inv.items.map((it, i) => ({
            zohoItemId: it.product.id,
            name: it.product.name,
            quantity: it.quantity,
            rate: it.rate,
            unit: 'pza',
            lineTotal: it.lineTotal,
            taxName: 'IVA 16%',
            taxPercentage: 16,
            taxAmount: Math.round(it.lineTotal * 0.16 * 100) / 100,
            sortOrder: i,
          })),
        },
      },
    });
  }

  // ---------------------------------------------------------------------
  // Customer Payments
  // ---------------------------------------------------------------------
  const paymentsSpec = [
    { id: 'demo-pay-1', number: 'PAY-00001', customer: customers[0], amount: 24500, mode: 'Transferencia bancaria', status: 'success', daysAgo_: 19 },
    { id: 'demo-pay-2', number: 'PAY-00002', customer: customers[1], amount: 8600, mode: 'Efectivo', status: 'deposited', daysAgo_: 6 },
    { id: 'demo-pay-3', number: 'PAY-00003', customer: customers[2], amount: 5200, mode: 'Tarjeta de crédito', status: 'pending', daysAgo_: 1 },
    { id: 'demo-pay-4', number: 'PAY-00004', customer: customers[0], amount: 3100, mode: 'Cheque', status: 'refunded', daysAgo_: 30 },
  ];

  for (const p of paymentsSpec) {
    await prisma.customerPayment.create({
      data: {
        id: p.id,
        zohoPaymentId: p.id,
        paymentNumber: p.number,
        paymentMode: p.mode,
        status: p.status,
        date: daysAgo(p.daysAgo_),
        amount: p.amount,
        balance: 0,
        zohoCustomerId: p.customer.id,
        customerName: p.customer.name,
        currencyCode: 'MXN',
        referenceNumber: `REF-${p.number}`,
        description: 'Pago registrado por el seed de datos demo.',
        sourceRemoteModifiedAt: now(),
        sourceSnapshotId: SNAPSHOT_ID,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Purchase Orders
  // ---------------------------------------------------------------------
  const poSpec = [
    { id: 'demo-po-1', number: 'PO-00001', vendor: vendors[0], status: 'open', daysAgo_: 10, items: lineItems(2, 0) },
    { id: 'demo-po-2', number: 'PO-00002', vendor: vendors[1], status: 'billed', daysAgo_: 25, items: lineItems(2, 3) },
    { id: 'demo-po-3', number: 'PO-00003', vendor: vendors[2], status: 'draft', daysAgo_: 2, items: lineItems(2, 5) },
    { id: 'demo-po-4', number: 'PO-00004', vendor: vendors[0], status: 'closed', daysAgo_: 60, items: lineItems(3, 7) },
  ];

  for (const po of poSpec) {
    const { subtotal, taxTotal, total } = totals(po.items);
    await prisma.purchaseOrder.create({
      data: {
        id: po.id,
        zohoPurchaseOrderId: po.id,
        purchaseOrderNumber: po.number,
        status: po.status,
        date: daysAgo(po.daysAgo_),
        dueDate: daysFromNow(15),
        zohoVendorId: po.vendor.id,
        vendorName: po.vendor.name,
        currencyCode: 'MXN',
        subTotal: subtotal,
        taxTotal,
        discountTotal: 0,
        shippingCharge: 0,
        total,
        balance: po.status === 'closed' ? 0 : total,
        salespersonName: 'Papa',
        referenceNumber: `REF-${po.number}`,
        notes: 'Orden de compra generada por el seed de datos demo.',
        sourceRemoteModifiedAt: now(),
        sourceSnapshotId: SNAPSHOT_ID,
        items: {
          create: po.items.map((it, i) => ({
            zohoItemId: it.product.id,
            name: it.product.name,
            quantity: it.quantity,
            rate: it.rate * 0.7,
            unit: 'pza',
            lineTotal: Math.round(it.lineTotal * 0.7 * 100) / 100,
            taxName: 'IVA 16%',
            taxPercentage: 16,
            taxAmount: Math.round(it.lineTotal * 0.7 * 0.16 * 100) / 100,
            sortOrder: i,
          })),
        },
      },
    });
  }

  // ---------------------------------------------------------------------
  // Bills
  // ---------------------------------------------------------------------
  const billsSpec = [
    { id: 'demo-bill-1', number: 'BILL-00001', vendor: vendors[0], status: 'paid', daysAgo_: 9, total: 18200 },
    { id: 'demo-bill-2', number: 'BILL-00002', vendor: vendors[1], status: 'open', daysAgo_: 3, total: 9400 },
    { id: 'demo-bill-3', number: 'BILL-00003', vendor: vendors[2], status: 'overdue', daysAgo_: 35, total: 6100 },
  ];

  for (const b of billsSpec) {
    await prisma.bill.create({
      data: {
        id: b.id,
        zohoBillId: b.id,
        billNumber: b.number,
        status: b.status,
        date: daysAgo(b.daysAgo_),
        dueDate: daysFromNow(b.status === 'overdue' ? -10 : 20),
        zohoVendorId: b.vendor.id,
        vendorName: b.vendor.name,
        currencyCode: 'MXN',
        subTotal: Math.round((b.total / 1.16) * 100) / 100,
        taxTotal: Math.round((b.total - b.total / 1.16) * 100) / 100,
        total: b.total,
        balance: b.status === 'paid' ? 0 : b.total,
        notes: 'Factura de compra generada por el seed de datos demo.',
        sourceRemoteModifiedAt: now(),
        sourceSnapshotId: SNAPSHOT_ID,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Vendor Credits
  // ---------------------------------------------------------------------
  const vendorCreditsSpec = [
    { id: 'demo-vc-1', number: 'VC-00001', vendor: vendors[0], status: 'open', total: 1500 },
    { id: 'demo-vc-2', number: 'VC-00002', vendor: vendors[1], status: 'applied', total: 850 },
  ];

  for (const vc of vendorCreditsSpec) {
    await prisma.vendorCredit.create({
      data: {
        id: vc.id,
        zohoVendorCreditId: vc.id,
        vendorCreditNumber: vc.number,
        status: vc.status,
        date: daysAgo(7),
        zohoVendorId: vc.vendor.id,
        vendorName: vc.vendor.name,
        currencyCode: 'MXN',
        total: vc.total,
        balance: vc.status === 'applied' ? 0 : vc.total,
        notes: 'Crédito de proveedor generado por el seed de datos demo.',
        sourceRemoteModifiedAt: now(),
        sourceSnapshotId: SNAPSHOT_ID,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Packages
  // ---------------------------------------------------------------------
  const packagesSpec = [
    { id: 'demo-pkg-1', number: 'PKG-00001', so: salesOrdersSpec[0], status: 'shipped', carrier: 'Estafeta' },
    { id: 'demo-pkg-2', number: 'PKG-00002', so: salesOrdersSpec[1], status: 'delivered', carrier: 'FedEx' },
    { id: 'demo-pkg-3', number: 'PKG-00003', so: salesOrdersSpec[3], status: 'pending', carrier: 'DHL' },
  ];

  for (const pkg of packagesSpec) {
    await prisma.package.create({
      data: {
        id: pkg.id,
        zohoPackageId: pkg.id,
        packageNumber: pkg.number,
        status: pkg.status,
        date: daysAgo(5),
        shipmentType: 'outbound',
        carrier: pkg.carrier,
        trackingNumber: `TRK${pkg.number}`,
        deliveryMethod: 'Paquetería',
        zohoSalesOrderId: pkg.so.id,
        zohoCustomerId: pkg.so.customer.id,
        customerName: pkg.so.customer.name,
        shippingCity: pkg.so.customer.city,
        shippingState: pkg.so.customer.state,
        shippingCountry: 'México',
        shipmentDate: daysAgo(4),
        shipmentStatus: pkg.status,
        isCarrierShipment: true,
        isTrackingEnabled: true,
        salesorderNumber: pkg.so.number,
        quantity: pkg.so.items.reduce((s, it) => s + it.quantity, 0),
        sourceRemoteModifiedAt: now(),
        sourceSnapshotId: SNAPSHOT_ID,
        items: {
          create: pkg.so.items.map((it, i) => ({
            zohoItemId: it.product.id,
            name: it.product.name,
            sku: it.product.sku,
            quantity: it.quantity,
            unit: 'pza',
            sortOrder: i,
          })),
        },
      },
    });
  }

  // ---------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------
  const notificationsSpec = [
    { id: 'demo-notif-1', title: 'Nueva orden de venta confirmada', body: 'SO-00002 fue confirmada por Ferretería La Unión.', read: false },
    { id: 'demo-notif-2', title: 'Factura vencida', body: 'INV-00003 está vencida desde hace 15 días.', read: false },
    { id: 'demo-notif-3', title: 'Pago recibido', body: 'Se registró el pago PAY-00001 por $24,500 MXN.', read: true },
    { id: 'demo-notif-4', title: 'Orden de compra facturada', body: 'PO-00002 fue facturada por Materiales y Suministros MX.', read: true },
    { id: 'demo-notif-5', title: 'Paquete entregado', body: 'PKG-00002 fue entregado por FedEx.', read: false },
  ];

  for (const n of notificationsSpec) {
    await prisma.notification.create({
      data: {
        id: n.id,
        userId: actorUserId,
        type: 'system',
        title: n.title,
        body: n.body,
        readAt: n.read ? daysAgo(1) : null,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Inbox (Comm*)
  // ---------------------------------------------------------------------
  const commAccount = await prisma.commAccount.create({
    data: {
      id: 'demo-comm-account-1',
      provider: 'twilio_whatsapp',
      label: 'WhatsApp Ventas',
      identifier: '+525512345678',
      status: 'active',
    },
  });

  const commContactsSpec = [
    { id: 'demo-comm-contact-1', name: 'Luis Hernández', phone: '+52 55 4455 6677' },
    { id: 'demo-comm-contact-2', name: 'Marta Reyes', phone: '+52 81 3322 1100' },
    { id: 'demo-comm-contact-3', name: 'Jorge Padilla', phone: '+52 33 9988 7766' },
    { id: 'demo-comm-contact-4', name: 'Ana Cervantes', phone: '+52 222 111 2233' },
  ];

  for (const cc of commContactsSpec) {
    await prisma.commContact.create({
      data: { id: cc.id, displayName: cc.name, phone: cc.phone },
    });
  }

  const conversationsSpec = [
    { id: 'demo-conv-1', contact: commContactsSpec[0], status: 'open', subject: 'Cotización de material eléctrico' },
    { id: 'demo-conv-2', contact: commContactsSpec[1], status: 'pending', subject: 'Seguimiento de pedido SO-00002' },
    { id: 'demo-conv-3', contact: commContactsSpec[2], status: 'snoozed', subject: 'Duda sobre factura' },
    { id: 'demo-conv-4', contact: commContactsSpec[3], status: 'resolved', subject: 'Reclamo de entrega' },
  ];

  const sampleMessages = [
    { body: 'Hola, buenas tardes, quisiera cotizar cable eléctrico.', direction: 'inbound', status: 'read' },
    { body: 'Claro, con gusto. ¿Cuántos metros necesitas?', direction: 'outbound', status: 'delivered' },
    { body: 'Como 200 metros de calibre 10.', direction: 'inbound', status: 'read' },
    { body: 'Te comparto la cotización en un momento.', direction: 'outbound', status: 'sent' },
  ];

  for (const conv of conversationsSpec) {
    await prisma.commConversation.create({
      data: {
        id: conv.id,
        accountId: commAccount.id,
        contactId: conv.contact.id,
        status: conv.status,
        subject: conv.subject,
        priority: 'normal',
        lastMessageAt: daysAgo(1),
        lastInboundAt: daysAgo(1),
        messages: {
          create: sampleMessages.map((m, i) => ({
            accountId: commAccount.id,
            externalId: `${conv.id}-msg-${i + 1}`,
            direction: m.direction,
            body: m.body,
            status: m.status,
            createdAt: daysAgo(1),
          })),
        },
      },
    });
  }

  // ---------------------------------------------------------------------
  // Campaigns
  // ---------------------------------------------------------------------
  const campaign = await prisma.campaign.create({
    data: {
      id: 'demo-campaign-1',
      name: 'Promoción de temporada — materiales de construcción',
      channel: 'whatsapp',
      accountId: commAccount.id,
      status: 'scheduled',
      audienceSnapshot: { filter: 'todos los clientes activos', count: commContactsSpec.length, frozenAt: now().toISOString() },
      contentSnapshot: { body: 'Aprovecha 10% de descuento en materiales seleccionados esta semana.' },
      budgetLimit: 2000,
      budgetSpent: 0,
      scheduledAt: daysFromNow(2),
      createdBy: actorUserId,
      recipients: {
        create: commContactsSpec.map((cc, i) => ({
          contactId: cc.id,
          identifier: cc.phone,
          status: i === 0 ? 'sent' : 'pending',
        })),
      },
    },
  });

  // ---------------------------------------------------------------------
  // Internal chat
  // ---------------------------------------------------------------------
  const channel = await prisma.internalChatChannel.create({
    data: {
      id: 'demo-chat-channel-1',
      type: 'group',
      name: 'General',
      createdBy: actorUserId,
      members: {
        create: [{ userId: actorUserId, role: 'admin' }],
      },
    },
  });

  const chatMessages = [
    'Bienvenidos al canal General de UNIK.',
    'Aquí vamos a coordinar pendientes del día a día.',
    'Recuerden revisar las solicitudes abiertas antes de las 6pm.',
  ];
  for (const [i, body] of chatMessages.entries()) {
    await prisma.internalChatMessage.create({
      data: {
        channelId: channel.id,
        senderId: actorUserId,
        content: body,
        createdAt: daysAgo(chatMessages.length - i),
      },
    });
  }

  // ---------------------------------------------------------------------
  // AI Assistant conversations
  // ---------------------------------------------------------------------
  const aiConversation = await prisma.aiConversation.create({
    data: {
      id: 'demo-ai-conv-1',
      userId: actorUserId,
      title: 'Resumen de ventas de la semana',
    },
  });
  await prisma.aiMessage.createMany({
    data: [
      { conversationId: aiConversation.id, role: 'user', content: '¿Cuántas órdenes de venta están confirmadas esta semana?' },
      { conversationId: aiConversation.id, role: 'assistant', content: 'Tienes 2 órdenes confirmadas: SO-00001 y SO-00002, por un total de $58,000 MXN aproximadamente.' },
    ],
  });

  return {
    contacts: customers.length + vendors.length,
    products: products.length,
    salesOrders: salesOrdersSpec.length,
    invoices: invoicesSpec.length,
    payments: paymentsSpec.length,
    purchaseOrders: poSpec.length,
    bills: billsSpec.length,
    vendorCredits: vendorCreditsSpec.length,
    packages: packagesSpec.length,
    notifications: notificationsSpec.length,
    conversations: conversationsSpec.length,
    campaigns: 1,
    campaignId: campaign.id,
    chatChannels: 1,
    aiConversations: 1,
  };
}
