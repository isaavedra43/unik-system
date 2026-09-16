import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ChatBotBadge } from './ChatBotBadge';

/**
 * Marca «IA» de los usuarios bot de la capa de agentes (plan 5.7). Se pinta
 * junto al nombre en el mensaje, en la lista de conversaciones y en la ficha de
 * miembros, así que tiene que leerse a 10 px sin robarle el ojo al nombre.
 */
const meta = {
  title: 'Chat/ChatBotBadge',
  component: ChatBotBadge,
  parameters: { layout: 'padded' },
  args: { withIcon: false },
} satisfies Meta<typeof ChatBotBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Predeterminada: Story = {};

export const ConIcono: Story = { args: { withIcon: true } };

/** Cómo se ve de verdad: pegada al nombre de quien escribió. */
export const JuntoAlNombre: Story = {
  render: (args) => (
    <div className="flex flex-col gap-2 text-sm">
      <span className="flex items-center gap-1.5">
        <strong>Copiloto de Compras</strong>
        <ChatBotBadge {...args} />
        <span className="text-muted-foreground">10:42</span>
      </span>
      <span className="flex items-center gap-1.5">
        <strong>Ana Ramírez</strong>
        <span className="text-muted-foreground">10:43</span>
      </span>
    </div>
  ),
};

/**
 * Sólo lee «IA» a la vista; el lector de pantalla dice «Asistente de IA».
 * Esta historia deja las dos capas a la vista para revisarlo.
 */
export const TextoAccesible: Story = {
  render: (args) => (
    <div className="flex flex-col gap-2 text-sm">
      <ChatBotBadge {...args} />
      <p className="text-muted-foreground text-xs">
        Visible: «IA» (aria-hidden). Para el lector de pantalla: «Asistente de IA».
      </p>
    </div>
  ),
};
