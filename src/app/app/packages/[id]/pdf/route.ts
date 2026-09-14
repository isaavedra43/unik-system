import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getPackageById } from '@/modules/packages/packages-service';
import { getPackagePdf } from '@/modules/integrations/zoho/packages';
import { ZohoApiError } from '@/modules/integrations/zoho/client';

export const runtime = 'nodejs';

/**
 * Streams the OFFICIAL Zoho Inventory PDF of the package — the same document
 * Zoho prints ("Orden de salida"): template, numbering and branding come from
 * Zoho, never from a local renderer. `?download=1` forces a download.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('packages.view'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { id } = await params;
  const pkg = await getPackageById(id);
  if (!pkg) return NextResponse.json({ error: 'Paquete no encontrado' }, { status: 404 });

  const download = new URL(request.url).searchParams.get('download') === '1';
  try {
    const { bytes, contentType } = await getPackagePdf(pkg.zohoPackageId);
    const filename = `${(pkg.packageNumber ?? pkg.zohoPackageId).replace(/[^\w.-]+/g, '_')}.pdf`;
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': contentType.includes('pdf') ? 'application/pdf' : contentType,
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof ZohoApiError) {
      return NextResponse.json(
        {
          error: error.zohoMessage ?? 'Zoho no entregó el PDF del paquete',
          code: error.zohoCode ?? null,
        },
        { status: error.httpStatus && error.httpStatus >= 400 ? 502 : 500 }
      );
    }
    if (error instanceof Error && error.message.startsWith('Invalid or missing Zoho')) {
      return NextResponse.json(
        { error: 'Faltan credenciales de Zoho en el servidor.' },
        { status: 503 }
      );
    }
    console.error('package pdf error', error);
    return NextResponse.json({ error: 'No se pudo obtener el PDF de Zoho' }, { status: 500 });
  }
}
