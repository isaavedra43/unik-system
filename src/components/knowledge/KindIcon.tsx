import React from 'react';
import { AlignLeft, FileCode2, FileSpreadsheet, FileText, Globe, Link2 } from 'lucide-react';
import type { RowKind } from './knowledge-api';

const ICONS: Record<RowKind, typeof FileText> = {
  pdf: FileText,
  word: FileText,
  excel: FileSpreadsheet,
  csv: FileSpreadsheet,
  text: AlignLeft,
  web: FileCode2,
  link: Link2,
  site: Globe,
};

/** Tinted tile that tells the file type at a glance (PDF red, Word blue, sheets green, web navy). */
export function KindIcon({ kind, large = false }: { kind: RowKind; large?: boolean }) {
  const Icon = ICONS[kind];
  return (
    <span className={`klib-kind klib-kind-${kind}${large ? ' klib-kind-lg' : ''}`} aria-hidden="true">
      <Icon size={large ? 20 : 18} />
    </span>
  );
}
