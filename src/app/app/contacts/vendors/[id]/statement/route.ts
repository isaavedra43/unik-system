import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getContactById } from '@/modules/contacts/contacts-service';
import { getVendorStatement } from '@/modules/contacts/vendor-statement-service';
import { isIsoDay } from '@/modules/contacts/vendor-statement';
import { formatCurrency, formatDateOnly } from '@/modules/contacts/contacts-helpers';
import { getBillStatusConfig } from '@/modules/bills/bills-helpers';
import { getVendorCreditStatusConfig } from '@/modules/vendor-credits/vendor-credits-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET ?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=pdf]
 * Vendor statement: opening balance (before `from`) + bills − credits with a running balance.
 * Without dates it covers the whole history. `format=pdf` downloads it.
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

  const statement = await getVendorStatement(contact.zohoContactId, { from: fromRaw, to: toRaw });
  if (sp.get('format') !== 'pdf') return NextResponse.json(statement);

  const currency = contact.currencyCode;
  const money = (n: number) => formatCurrency(n, currency);
  const period = statement.from || statement.to
    ? `${statement.from ? formatDateOnly(statement.from) : 'inicio'} a ${statement.to ? formatDateOnly(statement.to) : 'hoy'}`
    : `Todo el historial${statement.firstDocumentDate ? ` desde ${formatDateOnly(statement.firstDocumentDate)}` : ''}`;

  const { generatePdfReport } = await import('@/modules/ai/generators/pdf-generator');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unik-statement-'));
  const filePath = path.join(dir, 'estado.pdf');
  try {
    await generatePdfReport(filePath, {
      title: `Estado de cuenta · ${contact.contactName ?? 'Proveedor'}`,
      subtitle: `${period} · Generado ${formatDateOnly(new Date())}`,
      logoText: 'UNIK',
      brandColor: '#1e3a5f',
      orientation: 'portrait',
      summaryCards: [
        { label: 'Saldo inicial', value: money(statement.openingBalance) },
        { label: 'Facturas del periodo', value: money(statement.billsTotal) },
        { label: 'Créditos del periodo', value: money(statement.creditsTotal) },
        { label: 'Saldo actual', value: money(statement.closingBalance) },
      ],
      columns: [
        { header: 'Fecha', key: 'date', width: 60, nowrap: true },
        { header: 'Transacción', key: 'kind', width: 70 },
        { header: 'Folio', key: 'number', width: 80, nowrap: true },
        { header: 'Estado', key: 'status', width: 70 },
        { header: 'Cargo', key: 'charge', width: 80, align: 'right', nowrap: true },
        { header: 'Abono', key: 'credit', width: 80, align: 'right', nowrap: true },
        { header: 'Saldo', key: 'running', width: 90, align: 'right', nowrap: true },
      ],
      rows: [
        { date: statement.from ? formatDateOnly(statement.from) : '—', kind: 'Saldo inicial', number: '', status: '', charge: '', credit: '', running: money(statement.openingBalance) },
        ...statement.rows.map((r) => ({
          date: formatDateOnly(r.date),
          kind: r.kind === 'bill' ? 'Factura' : 'Crédito',
          number: r.number ?? '—',
          status: r.kind === 'bill' ? getBillStatusConfig(r.status).label : getVendorCreditStatusConfig(r.status).label,
          charge: r.kind === 'bill' ? money(Math.abs(r.amount)) : '',
          credit: r.kind === 'credit' ? money(Math.abs(r.amount)) : '',
          running: money(r.runningBalance),
        })),
      ],
    });
    const bytes = await fs.readFile(filePath);
    const safeName = (contact.contactName ?? 'proveedor').replace(/[^A-Za-z0-9]+/g, '_');
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="estado_de_cuenta_${safeName}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
