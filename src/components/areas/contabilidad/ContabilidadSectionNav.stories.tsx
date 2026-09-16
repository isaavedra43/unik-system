import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { CONTABILIDAD_SECTIONS } from '@/modules/areas/contabilidad/contabilidad-model';
import { ContabilidadSectionNav } from './ContabilidadSectionNav';

const meta = {
  title: 'Operaciones/ContabilidadSectionNav',
  component: ContabilidadSectionNav,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ContabilidadSectionNav>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { sections: CONTABILIDAD_SECTIONS, activeId: 'libro' },
};

export const EnObligaciones: Story = {
  args: { sections: CONTABILIDAD_SECTIONS, activeId: 'obligaciones' },
};

/** Alguien que sólo captura gastos ve dos secciones. */
export const SoloCaptura: Story = {
  args: {
    sections: CONTABILIDAD_SECTIONS.filter(
      (section) => section.id === 'gastos' || section.id === 'gastos-nuevo'
    ),
    activeId: 'gastos-nuevo',
  },
};
