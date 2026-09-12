import { fileURLToPath } from 'node:url';
import { type JobContext, ServerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import type { JSONSchema7 } from 'json-schema';
import { ParticipantKind, type RemoteParticipant } from '@livekit/rtc-node';
import { UnikClient, loadEnv, type AgentContext, type AgentToolSpec } from './unik-client.js';

/**
 * UNIK voice agent.
 *
 * One job per call, dispatched explicitly by UNIK with `{ callId }` in the job
 * metadata. The worker never decides policy on its own: the brief
 * (persona, rules, tools, model, voice, key) comes from UNIK, every tool call
 * is executed by UNIK, and the call state (pause / transfer / end) is polled
 * from UNIK so the agent stops the instant an operator pauses it.
 *
 * Audio: OpenAI Realtime (speech-to-speech) through LiveKit. The agent only
 * listens to the SIP participant (the phone), never to UNIK operators that
 * join the room to listen or take over.
 */

const log = (callId: string, msg: string, extra?: unknown) => {
  const line = `[voice-agent] ${callId} ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * With a speech-to-speech model there is no separate TTS, so `session.say`
 * (plain text) throws. Every fixed phrase goes through `generateReply` with an
 * instruction to say it verbatim; the returned handle can be awaited.
 */
function speakVerbatim(
  session: voice.AgentSession,
  phrase: string,
  allowInterruptions = true
): ReturnType<voice.AgentSession['generateReply']> {
  return session.generateReply({
    instructions: `Di exactamente esto, con naturalidad y sin agregar nada: "${phrase}"`,
    allowInterruptions,
  });
}

function isPhoneParticipant(p: RemoteParticipant): boolean {
  return (
    p.kind === ParticipantKind.SIP || p.identity.startsWith('sip_') || p.identity.startsWith('sip-')
  );
}

async function waitForPhone(ctx: JobContext, timeoutMs: number): Promise<RemoteParticipant | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const p of ctx.room.remoteParticipants.values()) {
      if (isPhoneParticipant(p)) return p;
    }
    await sleep(250);
  }
  return null;
}

function summarizeForModel(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > 6000 ? `${text.slice(0, 6000)}…` : text;
}

interface CallRuntime {
  callId: string;
  generation: number;
  ended: boolean;
  hangupRequested: boolean;
  transferRequested: boolean;
  /** Goodbye speech to wait for before asking UNIK to hang up. */
  goodbye: { waitForPlayout(): Promise<void> } | null;
}

function buildTools(
  brief: AgentContext,
  unik: UnikClient,
  rt: CallRuntime
): Record<string, ReturnType<typeof llm.tool>> {
  const tools: Record<string, ReturnType<typeof llm.tool>> = {};
  for (const spec of brief.tools) {
    tools[spec.name] = toolFromSpec(spec, unik, rt);
  }
  return tools;
}

function toolFromSpec(spec: AgentToolSpec, unik: UnikClient, rt: CallRuntime) {
  return llm.tool({
    description: spec.description,
    parameters: spec.parameters as JSONSchema7,
    execute: async (args: unknown) => {
      const payload = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
      try {
        const result = await unik.tool({
          callId: rt.callId,
          name: spec.name,
          args: payload,
          generation: rt.generation,
        });
        if (!result.ok) {
          if (result.code === 'ai_paused' || result.code === 'call_not_active') {
            return 'La llamada está siendo atendida por una persona; no respondas más.';
          }
          return `No fue posible: ${result.error}`;
        }
        if (spec.name === 'terminarLlamada') rt.hangupRequested = true;
        if (spec.name === 'solicitarTransferencia') rt.transferRequested = true;
        return summarizeForModel(result.result);
      } catch (err) {
        log(rt.callId, `tool ${spec.name} failed`, err instanceof Error ? err.message : err);
        return 'No pude consultar esa información en este momento; ofrece que un asesor dé seguimiento.';
      }
    },
  });
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const env = loadEnv();
    const unik = new UnikClient(env.unikBaseUrl, env.unikApiKey);

    let callId = '';
    try {
      const meta = JSON.parse(ctx.job.metadata || '{}') as { callId?: string };
      callId = String(meta.callId ?? '');
    } catch {
      callId = '';
    }
    if (!callId) {
      console.error('[voice-agent] job without callId in metadata; ignoring');
      return;
    }

    let brief: AgentContext;
    try {
      brief = await unik.context(callId);
    } catch (err) {
      console.error(
        '[voice-agent] cannot load brief',
        callId,
        err instanceof Error ? err.message : err
      );
      return;
    }
    if (!brief.aiAnswers) {
      log(callId, 'call is not in answer mode; nothing to do');
      return;
    }
    if (!brief.openaiApiKey) {
      await unik
        .event(callId, 'error', 'OpenAI API key no configurada en UNIK')
        .catch(() => undefined);
      log(callId, 'no OpenAI key; aborting');
      return;
    }

    const rt: CallRuntime = {
      callId,
      generation: brief.aiGeneration,
      ended: false,
      hangupRequested: false,
      transferRequested: false,
      goodbye: null,
    };

    try {
      await ctx.connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(callId, 'cannot join room', message);
      await unik
        .event(callId, 'error', `No se pudo entrar a la sala: ${message.slice(0, 300)}`)
        .catch(() => undefined);
      return;
    }
    await unik.event(callId, 'joined').catch(() => undefined);

    // Only the phone leg is our interlocutor. Operators may join to listen or
    // take over; their audio must never be treated as the customer.
    const phone = await waitForPhone(ctx, env.waitForCallerMs);
    if (!phone) {
      log(callId, 'no phone participant joined; leaving');
      await unik.event(callId, 'left', 'sin participante telefónico').catch(() => undefined);
      return;
    }

    const sttLanguage =
      brief.language === 'en' ? 'en' : brief.language === 'auto' ? undefined : 'es';
    const supportsReasoning = /^gpt-realtime/.test(brief.model);
    const model = new openai.realtime.RealtimeModel({
      model: brief.model,
      voice: brief.voice,
      apiKey: brief.openaiApiKey,
      ...(brief.openaiEndpoint ? { baseURL: brief.openaiEndpoint } : {}),
      speed: brief.speed,
      ...(supportsReasoning ? { reasoning: { effort: brief.reasoningEffort } } : {}),
      inputAudioTranscription: {
        model: brief.sttModel || 'gpt-4o-transcribe',
        ...(sttLanguage ? { language: sttLanguage } : {}),
      },
      inputAudioNoiseReduction:
        brief.noiseReduction === 'off' ? null : { type: brief.noiseReduction },
      turnDetection: {
        type: 'semantic_vad',
        eagerness: brief.turnEagerness,
        create_response: true,
        interrupt_response: true,
      },
      maxSessionDuration: Math.max(60, brief.maxAnswerSeconds + 120) * 1000,
    });
    const callStartedAt = Date.now();
    const elapsedMs = () => Date.now() - callStartedAt;

    const agent = new voice.Agent({
      instructions: brief.instructions,
      tools: buildTools(brief, unik, rt),
    });

    const session = new voice.AgentSession({
      llm: model,
      userAwayTimeout: Math.max(5, brief.silenceCheckSeconds) * 1000,
    });

    // Transcript → UNIK (gated there by aiState/aiGeneration).
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal || !ev.transcript.trim()) return;
      const at = elapsedMs();
      unik
        .transcript({
          callId,
          speaker: 'caller',
          text: ev.transcript,
          generation: rt.generation,
          startMs: at,
          endMs: at,
        })
        .catch(() => undefined);
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item as { role?: string; textContent?: string };
      if (item.role !== 'assistant') return;
      const text = item.textContent?.trim();
      if (!text) return;
      const at = elapsedMs();
      unik
        .transcript({
          callId,
          speaker: 'ai',
          text,
          generation: rt.generation,
          startMs: at,
          endMs: at,
        })
        .catch(() => undefined);
    });

    // Silence handling: one gentle check, then a polite goodbye.
    let awayCount = 0;
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState !== 'away' || rt.ended) return;
      awayCount += 1;
      if (awayCount === 1) {
        session.generateReply({
          instructions: 'Pregunta con amabilidad si el cliente sigue en la línea. Una sola frase.',
        });
      } else {
        rt.hangupRequested = true;
        rt.goodbye = speakVerbatim(
          session,
          'Parece que se cortó la comunicación. Gracias por llamar a UNIK, que tenga un excelente día.',
          false
        );
      }
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      log(callId, 'session error', ev);
      unik
        .event(callId, 'error', String((ev as { error?: unknown }).error ?? 'session_error'))
        .catch(() => undefined);
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: { participantIdentity: phone.identity, closeOnDisconnect: true },
      outputOptions: { transcriptionEnabled: true, syncTranscription: true },
    });

    speakVerbatim(session, brief.greeting, true);
    await unik.event(callId, 'greeted').catch(() => undefined);
    const startedAt = Date.now();
    let offeredTransferForTime = false;

    const interrupt = async () => {
      try {
        await session.interrupt({ force: true }).await;
      } catch {
        /* nothing playing */
      }
    };

    const leave = async (reason: string) => {
      if (rt.ended) return;
      rt.ended = true;
      log(callId, `leaving: ${reason}`);
      try {
        await session.close();
      } catch {
        /* ignore */
      }
      await unik.event(callId, 'left', reason).catch(() => undefined);
    };

    ctx.addShutdownCallback(() => leave('shutdown'));

    // Control loop: UNIK is the source of truth for pause / transfer / end.
    while (!rt.ended) {
      await sleep(env.pollIntervalMs);
      if (rt.ended) break;

      if (rt.hangupRequested) {
        // Let the goodbye finish (the model speaks it right after the tool
        // call), then ask UNIK to hang up the phone leg.
        if (rt.goodbye) await rt.goodbye.waitForPlayout().catch(() => undefined);
        else await sleep(3500);
        await unik.event(callId, 'hangup', 'despedida completada').catch(() => undefined);
        await leave('hangup');
        break;
      }

      let state;
      try {
        state = await unik.state(callId);
      } catch (err) {
        log(callId, 'state poll failed', err instanceof Error ? err.message : err);
        continue;
      }
      if (state.status !== 'active' && state.status !== 'ringing') {
        await leave(`call ${state.status}`);
        break;
      }
      if (!state.externalPresent && ctx.room.remoteParticipants.size === 0) {
        await leave('phone left');
        break;
      }
      rt.generation = state.aiGeneration;

      if (state.aiState === 'paused') {
        // An operator paused the AI: stop talking immediately and leave; UNIK
        // dispatches a fresh job on resume.
        await interrupt();
        await leave('paused by operator');
        break;
      }
      if (!state.aiAnswers) {
        // Transfer completed (AI participant retired) or AI turned off.
        if (state.humanPresent) {
          await interrupt();
          const handle = speakVerbatim(
            session,
            'Le comunico ahora mismo con un compañero. Gracias por su paciencia.',
            false
          );
          await handle.waitForPlayout().catch(() => undefined);
        }
        await leave('handed over to human');
        break;
      }
      if (rt.transferRequested && state.humanPresent) {
        await interrupt();
        const handle = speakVerbatim(
          session,
          'Ya está con usted mi compañero. Hasta luego.',
          false
        );
        await handle.waitForPlayout().catch(() => undefined);
        await leave('transfer completed');
        break;
      }

      const elapsed = (Date.now() - startedAt) / 1000;
      if (!offeredTransferForTime && elapsed > brief.maxAnswerSeconds) {
        offeredTransferForTime = true;
        session.generateReply({
          instructions:
            'La llamada se ha alargado. Ofrece con cortesía comunicar al cliente con un asesor o que un asesor le devuelva la llamada; si acepta la transferencia usa la herramienta solicitarTransferencia.',
        });
      }
    }
  },
});

/**
 * LiveKit Cloud shows an https:// project URL, but joining a room needs the
 * WebSocket endpoint. Accept either and normalize so a copied value works.
 */
function livekitWsUrl(): string | undefined {
  const raw = process.env.LIVEKIT_URL?.trim();
  if (!raw) return undefined;
  return raw
    .replace(/^https:\/\//i, 'wss://')
    .replace(/^http:\/\//i, 'ws://')
    .replace(/\/+$/, '');
}

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.VOICE_AGENT_NAME?.trim() || 'unik-voice',
    wsURL: livekitWsUrl(),
  })
);
