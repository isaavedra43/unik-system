import type { Decorator, Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { ChatAgentRequestMeta } from '@/modules/chat/chat-events';
import { ChatAgentActions } from './ChatAgentActions';

/**
 * Acciones rápidas bajo un mensaje de la IA en un canal de área o en la sala de
 * un expediente (plan 5.7). El servidor decide siempre quién puede actuar; el
 * cliente sólo esconde lo que no aplica, así que estas historias recorren los
 * estados que cambian lo que se ve: pendiente, ya decidida, copia informativa,
 * sin permiso, vacía (no pinta nada) y el error del envío.
 *
 * El componente lee el estado vivo de la solicitud al montarse
 * (`GET /app/operations/api/requests/:id`) y actúa con un POST. Aquí esa red se
 * sustituye por un doble determinista: `parameters.fetchMode` decide si
 * responde, si tarda para siempre (cargando) o si falla.
 */

const USER = 'u-ana';

const base: ChatAgentRequestMeta = {
  kind: 'agent_request',
  requestId: 'req-1',
  caseId: 'case-1',
  areaKey: 'logistica',
  quickActions: ['accept', 'block', 'open_case'],
  actorUserIds: [USER],
  status: 'sent',
  copyOf: null,
};

type FetchMode = 'ok' | 'pending' | 'fail';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 409,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Sustituye `fetch` mientras dura la historia y lo devuelve al salir, para que
 * una historia no contamine a la siguiente.
 */
const withFetch: Decorator = (Story, context) => {
  const mode = (context.parameters.fetchMode ?? 'ok') as FetchMode;
  const args = context.args as { meta?: ChatAgentRequestMeta };
  const status = (context.parameters.liveStatus ?? args.meta?.status ?? null) as string | null;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const isWrite = init?.method === 'POST';
    if (mode === 'pending' && isWrite) return new Promise<Response>(() => undefined);
    if (mode === 'fail' && isWrite) {
      return jsonResponse({ error: 'La solicitud ya la resolvió otra persona' }, false);
    }
    if (url.endsWith('/respond')) return jsonResponse({ ok: true });
    return jsonResponse({ request: { status } });
  }) as typeof fetch;
  queueMicrotask(() => {
    // Se restaura en cuanto la historia terminó de montar y disparó sus lecturas.
    setTimeout(() => {
      globalThis.fetch = original;
    }, 2000);
  });
  return (
    <div style={{ maxWidth: 560 }}>
      <p className="text-sm">
        <strong>Copiloto de Logística</strong> · Ventas necesita confirmar la entrega del expediente
        EXP-42.
      </p>
      <Story />
    </div>
  );
};

const meta = {
  title: 'Chat/ChatAgentActions',
  component: ChatAgentActions,
  parameters: { layout: 'padded' },
  decorators: [withFetch],
  args: { meta: base, currentUserId: USER },
} satisfies Meta<typeof ChatAgentActions>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Lo normal: el responsable del área puede aceptarla o bloquearla. */
export const Pendiente: Story = {};

/** Ya aceptada: queda bloquearla (cambiar de opinión) y ver el expediente. */
export const Aceptada: Story = {
  args: { meta: { ...base, status: 'accepted' } },
  parameters: { liveStatus: 'accepted' },
};

/** Cerrada: sólo la etiqueta de estado y el enlace al expediente. */
export const Resuelta: Story = {
  args: { meta: { ...base, status: 'resolved' } },
  parameters: { liveStatus: 'resolved' },
};

/**
 * DESHABILITADA: la copia que se publica en el canal del área informa, no
 * decide. La decisión se toma en la tarjeta de la sala del expediente.
 */
export const CopiaDelCanal: Story = {
  args: { meta: { ...base, copyOf: 'msg-original' } },
};

/** DESHABILITADA: quien mira no es responsable ni suplente del área. */
export const SinPermiso: Story = {
  args: { meta: { ...base, actorUserIds: ['u-otro'] } },
};

/**
 * VACÍA: sin acciones, sin expediente y sin estado el componente no pinta nada
 * (el mensaje de la IA se queda solo, que es lo correcto).
 */
export const SinNadaQueOfrecer: Story = {
  args: { meta: { ...base, quickActions: [], caseId: null, status: null } },
  parameters: { liveStatus: null },
  render: (args) => (
    <div>
      <ChatAgentActions {...args} />
      <p className="text-muted-foreground text-xs">
        (No se pinta ningún control: es el resultado esperado.)
      </p>
    </div>
  ),
};

/** CARGANDO: el envío quedó en vuelo; los dos botones se deshabilitan. */
export const Enviando: Story = {
  parameters: { fetchMode: 'pending' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Aceptar' }));
    await expect(await canvas.findByRole('button', { name: 'Bloquear' })).toBeDisabled();
  },
};

/** ERROR: el motor rechazó la acción; se anuncia una vez, en línea. */
export const ErrorDelMotor: Story = {
  parameters: { fetchMode: 'fail' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Aceptar' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'La solicitud ya la resolvió otra persona'
    );
  },
};
