import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInboxUser, commsErrorResponse, readJson } from '../../../_shared';
import { getConversation, transcriptFor } from '@/modules/comms/comms-service';
import { summarizeConversation, suggestReply, translateText } from '@/modules/comms/comms-ai';
import { suggestCommitments } from '@/modules/comms/commitments-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  action: z.enum(['summarize', 'suggest_reply', 'translate']),
  text: z.string().max(8000).optional(),
  targetLanguage: z.string().max(40).optional(),
  instructions: z.string().max(500).optional(),
});

/** POST { action: summarize | suggest_reply | translate } — assistive text for the fixed AI panel. Never sends. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const input = schema.parse(await readJson(request));
    await getConversation(auth.user, id);
    const { messages, contactName } = await transcriptFor(id);
    if (input.action === 'summarize') {
      return NextResponse.json({
        result: await summarizeConversation(messages, contactName, auth.user.id),
      });
    }
    if (input.action === 'suggest_reply') {
      const draft = await suggestReply(messages, contactName, {
        instructions: input.instructions,
        userId: auth.user.id,
      });
      return NextResponse.json({ result: draft, commitments: suggestCommitments(draft) });
    }
    const source =
      input.text?.trim() ||
      messages.filter((m) => m.direction === 'inbound').slice(-1)[0]?.body ||
      '';
    if (!source) return NextResponse.json({ error: 'No hay texto para traducir' }, { status: 400 });
    return NextResponse.json({
      result: await translateText(source, input.targetLanguage ?? 'español', auth.user.id),
    });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
