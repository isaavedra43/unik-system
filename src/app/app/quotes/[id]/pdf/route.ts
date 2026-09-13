import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getQuotePdfFromZoho, QuoteWriteError } from '@/modules/quotes/quotes-write-service';

export const runtime = 'nodejs';

/**
 * Streams the OFFICIAL Zoho Books PDF for the quote. UNIK never renders its
 * own quote PDF — the template, numbering and branding always come from Zoho.
 * `?download=1` forces a download instead of inline preview.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('quotes.view'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  const download = new URL(request.url).searchParams.get('download') === '1';
  try {
    const { bytes, contentType, filename } = await getQuotePdfFromZoho(id);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof QuoteWriteError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    console.error('quote pdf error', error);
    return NextResponse.json({ error: 'No se pudo obtener el PDF de Zoho' }, { status: 500 });
  }
}
