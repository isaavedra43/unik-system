import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getContactById } from '@/modules/contacts/contacts-service';
import { getVendorStatement } from '@/modules/contacts/vendor-statement-service';
import { isIsoDay, parseStatementShow, type VendorStatement } from '@/modules/contacts/vendor-statement';
import { formatCurrency, formatDateOnly } from '@/modules/contacts/contacts-helpers';
import { getBillStatusConfig } from '@/modules/bills/bills-helpers';
import { getVendorCreditStatusConfig } from '@/modules/vendor-credits/vendor-credits-helpers';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&show=all|bills|credits[&format=pdf|xlsx|csv]
 * Vendor statement: opening balance (before `from`) + bills − credits with a running balance.
 * Without dates it covers the whole history. `format` downloads the same statement.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const user = session.user;
  if (!hasPermission(user, 'vendors.view') || !hasPermission(user, 'bills.view') || !hasPermission(user, 'vendor_credits.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { id } = await params;
  const contact = await getContactById(id);
  if (!contact || contact.contactType !== 'vendor') {
    return NextResponse.json({ error: 'Proveedor no encontrado' }, { status: 404 });
  }

  const sp = request.nextUrl.searchParams;
  const fromRaw = sp.get('from');
  const toRaw = sp.get('to');
  if ((fromRaw && !isIsoDay(fromRaw)) || (toRaw && !isIsoDay(toRaw))) {
    return NextResponse.json({ error: 'Fechas inválidas (usa AAAA-MM-DD)' }, { status: 400 });
  }
  if (fromRaw && toRaw && fromRaw > toRaw) {
    return NextResponse.json({ error: 'La fecha inicial es posterior a la final' }, { status: 400 });
  }

  const statement = await getVendorStatement(contact.zohoContactId, { from: fromRaw, to: toRaw, show: parseStatementShow(sp.get('show')) });
  const settings = await getAiSettings().catch(() => null);
  const company = {
    name: settings?.companyName?.trim() || 'UNIK',
    phone: settings?.companyPhone?.trim() || null,
    address: settings?.warehouseAddress?.trim() || null,
  };
  const format = sp.get('format');
  if (format !== 'pdf' && format !== 'xlsx' && format !== 'csv') {
    return NextResponse.json({ ...statement, company });
  }

  const currency = contact.currencyCode;
  const money = (n: number) => formatCurrency(n, currency);
  const period = statement.from || statement.to
    ? `${statement.from ? formatDateOnly(statement.from) : 'inicio'} a ${statement.to ? formatDateOnly(statement.to) : 'hoy'}`
    : `Todo el historial${statement.firstDocumentDate ? ` desde ${formatDateOnly(statement.firstDocumentDate)}` : ''}`;
  const vendorName = contact.contactName ?? 'Proveedor';
  const safeName = vendorName.replace(/[^A-Za-z0-9]+/g, '_');

  const summary = [
    { label: 'Saldo inicial', value: money(statement.openingBalance) },
    { label: 'Facturas del periodo', value: money(statement.billsTotal) },
    { label: 'Créditos del periodo', value: money(statement.creditsTotal) },
    { label: 'Saldo actual', value: money(statement.closingBalance) },
  ];
  const statusLabel = (r: VendorStatement['rows'][number]) =>
    r.kind === 'bill' ? getBillStatusConfig(r.status).label : getVendorCreditStatusConfig(r.status).label;
  const rows = [
    { date: statement.from ? formatDateOnly(statement.from) : statement.firstDocumentDate ? formatDateOnly(statement.firstDocumentDate) : '', kind: 'Saldo inicial', number: '', status: '', charge: '', credit: '', running: money(statement.openingBalance) },
    ...statement.rows.map((r) => ({
      date: formatDateOnly(r.date),
      kind: r.kind === 'bill' ? 'Factura de proveedor' : 'Crédito',
      number: r.number ?? '',
      status: statusLabel(r),
      charge: r.kind === 'bill' ? money(Math.abs(r.amount)) : '',
      credit: r.kind === 'credit' ? money(Math.abs(r.amount)) : '',
      running: money(r.runningBalance),
    })),
    { date: '', kind: 'Saldo actual', number: '', status: '', charge: money(statement.billsTotal), credit: money(statement.creditsTotal), running: money(statement.closingBalance) },
  ];
  const columns = [
    { header: 'Fecha', key: 'date' },
    { header: 'Transacción', key: 'kind' },
    { header: 'Folio', key: 'number' },
    { header: 'Estado', key: 'status' },
    { header: 'Cargo', key: 'charge' },
    { header: 'Abono', key: 'credit' },
    { header: 'Saldo', key: 'running' },
  ];
  const title = `Estado de cuenta · ${vendorName}`;
  const subtitle = `${company.name} · ${period} · Generado ${formatDateOnly(new Date())}`;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unik-statement-'));
  try {
    if (format === 'csv') {
      const { generateCsvReport } = await import('@/modules/ai/generators/csv-generator');
      const filePath = path.join(dir, 'estado.csv');
      generateCsvReport(filePath, { title: `${title} · ${period}`, columns, rows, includeMetadata: true });
      return fileResponse(await fs.readFile(filePath), 'text/csv; charset=utf-8', `estado_de_cuenta_${safeName}.csv`);
    }
    if (format === 'xlsx') {
      const { generateExcelReport } = await import('@/modules/ai/generators/excel-generator');
      const filePath = path.join(dir, 'estado.xlsx');
      await generateExcelReport(filePath, {
        title,
        subtitle,
        author: company.name,
        brandColor: 'FF1E3A5F',
        sheetName: 'Estado de cuenta',
        summaryCards: summary,
        columns: columns.map((c) => ({ ...c, width: c.key === 'kind' ? 22 : c.key === 'number' ? 16 : c.key === 'status' ? 14 : 18 })),
        rows,
      });
      return fileResponse(await fs.readFile(filePath), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `estado_de_cuenta_${safeName}.xlsx`);
    }
    const { generatePdfReport } = await import('@/modules/ai/generators/pdf-generator');
    const filePath = path.join(dir, 'estado.pdf');
    await generatePdfReport(filePath, {
      title,
      subtitle,
      logoText: company.name.slice(0, 8).toUpperCase(),
      brandColor: '#1e3a5f',
      orientation: 'portrait',
      summaryCards: summary,
      metadata: {
        Proveedor: vendorName,
        ...(contact.taxRegNo ? { RFC: contact.taxRegNo } : {}),
        ...(company.address ? { Dirección: company.address } : {}),
        ...(company.phone ? { Teléfono: company.phone } : {}),
      },
      columns: [
        { header: 'Fecha', key: 'date', width: 60, nowrap: true },
        { header: 'Transacción', key: 'kind', width: 80 },
        { header: 'Folio', key: 'number', width: 80, nowrap: true },
        { header: 'Estado', key: 'status', width: 70 },
        { header: 'Cargo', key: 'charge', width: 80, align: 'right', nowrap: true },
        { header: 'Abono', key: 'credit', width: 80, align: 'right', nowrap: true },
        { header: 'Saldo', key: 'running', width: 90, align: 'right', nowrap: true },
      ],
      rows: rows.slice(0, -1),
    });
    return fileResponse(await fs.readFile(filePath), 'application/pdf', `estado_de_cuenta_${safeName}.pdf`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function fileResponse(bytes: Buffer, contentType: string, fileName: string): NextResponse {
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
