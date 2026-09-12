/**
 * Thin HTTP client for UNIK's internal voice-agent API. Every request is
 * authenticated with the shared internal key (X-UNIK-API-Key) and has a short
 * timeout: the worker must never hang on UNIK while a caller is on the line.
 */

export interface AgentToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentContext {
  callId: string;
  roomName: string;
  aiIdentity: string;
  status: string;
  aiState: string;
  aiGeneration: number;
  aiAnswers: boolean;
  language: string;
  model: string;
  voice: string;
  speed: number;
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
  turnEagerness: 'auto' | 'low' | 'medium' | 'high';
  sttModel: string;
  noiseReduction: 'near_field' | 'far_field' | 'off';
  silenceCheckSeconds: number;
  openaiApiKey: string | null;
  openaiEndpoint: string | null;
  personaName: string;
  companyName: string;
  greeting: string;
  instructions: string;
  maxAnswerSeconds: number;
  tools: AgentToolSpec[];
  contact: { name: string | null; phone: string | null; known: boolean };
}

export interface AgentState {
  callId: string;
  status: string;
  aiState: string;
  aiGeneration: number;
  aiAnswers: boolean;
  humanPresent: boolean;
  externalPresent: boolean;
  endedAt: string | null;
}

export type AgentToolResult =
  { ok: true; result: unknown } | { ok: false; error: string; code: string };

export type AgentEventType = 'joined' | 'left' | 'error' | 'greeted' | 'hangup';

export class UnikClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 8000
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'X-UNIK-API-Key': this.apiKey,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!res.ok) {
        const msg =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : `HTTP ${res.status}`;
        throw new Error(`UNIK ${path}: ${msg}`);
      }
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }

  context(callId: string): Promise<AgentContext> {
    return this.request<AgentContext>(
      `/api/internal/voice/agent/context?callId=${encodeURIComponent(callId)}`
    );
  }

  state(callId: string): Promise<AgentState> {
    return this.request<AgentState>(
      `/api/internal/voice/agent/state?callId=${encodeURIComponent(callId)}`
    );
  }

  transcript(input: {
    callId: string;
    speaker: 'caller' | 'ai';
    text: string;
    generation: number;
    startMs?: number;
    endMs?: number;
  }): Promise<{ accepted: boolean; reason?: string }> {
    return this.request('/api/internal/voice/agent/transcript', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  tool(input: {
    callId: string;
    name: string;
    args: Record<string, unknown>;
    generation: number;
  }): Promise<AgentToolResult> {
    return this.request('/api/internal/voice/agent/tool', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  event(callId: string, type: AgentEventType, detail?: string): Promise<{ ok: true }> {
    return this.request('/api/internal/voice/agent/event', {
      method: 'POST',
      body: JSON.stringify({ callId, type, detail }),
    });
  }
}

export function loadEnv(): {
  unikBaseUrl: string;
  unikApiKey: string;
  agentName: string;
  pollIntervalMs: number;
  waitForCallerMs: number;
} {
  const unikBaseUrl = (process.env.UNIK_BASE_URL ?? '').replace(/\/+$/, '');
  const unikApiKey = process.env.UNIK_INTERNAL_API_KEY ?? '';
  if (!unikBaseUrl || !unikApiKey) {
    throw new Error('UNIK_BASE_URL y UNIK_INTERNAL_API_KEY son obligatorias');
  }
  return {
    unikBaseUrl,
    unikApiKey,
    agentName: process.env.VOICE_AGENT_NAME?.trim() || 'unik-voice',
    pollIntervalMs: Number(process.env.VOICE_AGENT_POLL_MS ?? 1500) || 1500,
    waitForCallerMs: Number(process.env.VOICE_AGENT_WAIT_CALLER_MS ?? 60000) || 60000,
  };
}
