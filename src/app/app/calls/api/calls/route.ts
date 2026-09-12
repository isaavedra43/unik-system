import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { readJson, requireCallsSession, voiceErrorResponse } from '../_shared';
import { createInternalCall, createOutboundCall, listCalls } from '@/modules/voice/voice-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = ['ringing', 'active', 'ended', 'failed', 'missed'] as const;
const TYPES = ['internal', 'inbound', 'outbound'] as const;

/** GET /app/calls/api/calls?status=active,ringing&type=inbound&limit=50 */
export async function GET(request: NextRequest) {
  const auth = await requireCallsSession();
  if ('response' in auth) return auth.response;
  const params = request.nextUrl.searchParams;
  const status = (params.get('status') ?? '')
    .split(',')
    .filter((s): s is (typeof STATUSES)[number] => (STATUSES as readonly string[]).includes(s));
  const type = (params.get('type') ?? '')
    .split(',')
    .filter((t): t is (typeof TYPES)[number] => (TYPES as readonly string[]).includes(t));
  const limit = Number(params.get('limit') ?? 50);
  try {
    const calls = await listCalls(auth.user, {
      status: status.length ? status : undefined,
      type: type.length ? type : undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return NextResponse.json({ calls });
  } catch (err) {
    return voiceErrorResponse(err);
  }
}

const createSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('internal'),
    calleeUserIds: z.array(z.string().min(1)).min(1).max(10),
  }),
  z.object({
    type: z.literal('outbound'),
    toNumber: z.string().min(8).max(20),
    accountId: z.string().optional(),
    contactId: z.string().optional(),
  }),
]);

/** POST /app/calls/api/calls — internal call or outbound PSTN call (calls.use). */
export async function POST(request: NextRequest) {
  const auth = await requireCallsSession(['calls.use']);
  if ('response' in auth) return auth.response;
  const parsed = createSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );
  }
  try {
    const result =
      parsed.data.type === 'internal'
        ? await createInternalCall(auth.user, { calleeUserIds: parsed.data.calleeUserIds })
        : await createOutboundCall(auth.user, {
            toNumber: parsed.data.toNumber,
            accountId: parsed.data.accountId ?? null,
            contactId: parsed.data.contactId ?? null,
          });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return voiceErrorResponse(err);
  }
}
