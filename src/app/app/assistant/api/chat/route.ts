import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { runAssistant } from '@/modules/ai/ai-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const chatRequestSchema = z.object({
  conversationId: z.string().min(1),
  message: z.string().min(1).max(50_000),
  context: z
    .object({
      page: z.string().optional(),
    })
    .optional(),
  model: z.string().optional(),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        fileName: z.string(),
        mimeType: z.string(),
        storagePath: z.string(),
      })
    )
    .optional(),
});

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runAssistant({
          conversationId: parsed.data.conversationId,
          message: parsed.data.message,
          actor: session.user,
          context: parsed.data.context,
          model: parsed.data.model,
          attachments: parsed.data.attachments,
        })) {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        }
      } catch (e) {
        const data = `data: ${JSON.stringify({
          type: 'error',
          data: { message: e instanceof Error ? e.message : 'Error desconocido' },
        })}\n\n`;
        controller.enqueue(encoder.encode(data));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
