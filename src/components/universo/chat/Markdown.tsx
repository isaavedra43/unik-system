'use client';

import React, { useMemo, useState } from 'react';
import { Check, Copy, Info, TriangleAlert, WrapText, CircleCheck } from 'lucide-react';
import { toneForStatusLabel } from '@/modules/ai/generators/status-tone';
import { cn } from '@/lib/utils';
import { renderInline } from './markdown-inline';
import { highlight, normalizeLang } from './highlight';

/**
 * Markdown for the assistant's answers — blocks rendered as React, inline
 * formatting through the sanitized `renderInline` (escapes HTML, safe hrefs
 * only). Supports headings, paragraphs, nested lists, task lists, tables
 * (numeric columns right-aligned, status words colored), quotes/callouts,
 * rules and fenced code with highlighting. Streaming-safe: an unclosed fence
 * renders as a live code block.
 */

type Block =
  | { kind: 'code'; lang: string; code: string; open: boolean }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'hr' }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'para'; lines: string[] };

interface ListItem {
  indent: number;
  text: string;
  task?: 'done' | 'todo';
}

const BULLET_RE = /^(\s*)[-*•+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE_RE = /^\s*(```|~~~)\s*([\w+#.-]*)/;
const TASK_RE = /^\[( |x|X)\]\s+(.*)$/;

function parse(content: string): Block[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (lines[i].trim().startsWith(marker)) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ kind: 'code', lang: fence[2] || '', code: body.join('\n'), open: !closed });
      continue;
    }
    if (
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])
    ) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i]);
        i++;
      }
      const cells = (r: string) =>
        r
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      blocks.push({ kind: 'table', head: cells(rows[0]), rows: rows.slice(2).map(cells) });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: Math.min(heading[1].length, 4), text: heading[2] });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }
    if (line.trim().startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        q.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', lines: q });
      continue;
    }
    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      const ordered = !BULLET_RE.test(line);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = BULLET_RE.exec(lines[i]) ?? ORDERED_RE.exec(lines[i]);
        if (!m) {
          // Continuation line of the previous item (indented text).
          if (items.length && /^\s{2,}\S/.test(lines[i])) {
            items[items.length - 1].text += ` ${lines[i].trim()}`;
            i++;
            continue;
          }
          break;
        }
        const indent = m[1].replace(/\t/g, '  ').length;
        const task = TASK_RE.exec(m[2]);
        items.push(
          task
            ? { indent, text: task[2], task: task[1].toLowerCase() === 'x' ? 'done' : 'todo' }
            : { indent, text: m[2] }
        );
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE_RE.test(lines[i]) &&
      !lines[i].trim().startsWith('|') &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !lines[i].trim().startsWith('>') &&
      !BULLET_RE.test(lines[i]) &&
      !ORDERED_RE.test(lines[i]) &&
      !HR_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) blocks.push({ kind: 'para', lines: para });
  }
  return blocks;
}

const Inline = ({
  text,
  as: Tag = 'span',
}: {
  text: string;
  as?: 'span' | 'p' | 'h1' | 'h2' | 'h3' | 'h4';
}) => <Tag dangerouslySetInnerHTML={{ __html: renderInline(text) }} />;

function renderList(items: ListItem[], ordered: boolean, key: string): React.ReactNode {
  const base = items[0]?.indent ?? 0;
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let hasTasks = false;
  while (i < items.length) {
    const item = items[i];
    const children: ListItem[] = [];
    let j = i + 1;
    while (j < items.length && items[j].indent > base) {
      children.push(items[j]);
      j++;
    }
    if (item.task) hasTasks = true;
    nodes.push(
      <li key={`${key}-${i}`} className={item.task ? 'uv-task' : undefined}>
        {item.task && (
          <span className={cn('uv-task-box', item.task === 'done' && 'is-done')} aria-hidden="true">
            {item.task === 'done' && <Check size={11} strokeWidth={3} />}
          </span>
        )}
        <span>
          <Inline text={item.text} />
          {children.length > 0 && renderList(children, ordered, `${key}-${i}`)}
        </span>
      </li>
    );
    i = j;
  }
  const Tag = ordered ? 'ol' : 'ul';
  return <Tag className={hasTasks ? 'is-tasks' : undefined}>{nodes}</Tag>;
}

const NUMERIC_RE = /^[-+]?[$€]?\s?[-+]?\d[\d,.\s]*%?(\s?(MXN|USD|pzas?|m2|m²|kg|hrs?|h|min))?$/i;

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  const numeric = head.map((_, c) => {
    const vals = rows.map((r) => (r[c] ?? '').replace(/\*\*/g, '').trim()).filter(Boolean);
    return vals.length > 0 && vals.every((v) => NUMERIC_RE.test(v) || v === '—' || v === '-');
  });
  return (
    <div className="uv-table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h, c) => (
              <th key={c} className={numeric[c] ? 'is-num' : undefined}>
                <Inline text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {head.map((_, c) => {
                const cell = r[c] ?? '';
                const tone = toneForStatusLabel(cell.replace(/\*\*/g, ''));
                return (
                  <td key={c} className={numeric[c] ? 'is-num' : undefined}>
                    {tone ? (
                      <span className={cn('uv-status-cell', `uv-pill is-${toneClass(tone)}`)}>
                        <Inline text={cell} />
                      </span>
                    ) : (
                      <Inline text={cell} />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function toneClass(tone: string): string {
  switch (tone) {
    case 'success':
      return 'live';
    case 'warning':
      return 'warn';
    case 'danger':
      return 'danger';
    case 'info':
      return 'info';
    default:
      return 'muted';
  }
}

export function CodeBlock({
  code,
  lang,
  live = false,
}: {
  code: string;
  lang?: string;
  live?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const html = useMemo(() => highlight(code, lang), [code, lang]);
  const label = normalizeLang(lang) || 'texto';
  return (
    <div className={cn('uv-code', wrap && 'is-wrap')}>
      <div className="uv-code-head">
        <span>{lang || label}</span>
        <button
          type="button"
          onClick={() => setWrap((v) => !v)}
          aria-pressed={wrap}
          title="Ajustar líneas"
        >
          <WrapText size={13} />
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          aria-label="Copiar código"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <pre className={live ? 'uv-caret' : undefined}>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

function Quote({ lines }: { lines: string[] }) {
  const first = lines[0] ?? '';
  const callout =
    /^\*\*(nota|importante|atenci[oó]n|aviso|tip|consejo|listo|hecho)\b/i.exec(first) ??
    /^(⚠️|ℹ️|✅)/.exec(first);
  if (callout) {
    const word = callout[1]?.toLowerCase() ?? '';
    const tone = /import|atenci|aviso|⚠/.test(word)
      ? 'warn'
      : /listo|hecho|✅/.test(word)
        ? 'ok'
        : 'info';
    const Icon = tone === 'warn' ? TriangleAlert : tone === 'ok' ? CircleCheck : Info;
    return (
      <blockquote className={cn('uv-callout', tone !== 'info' && `is-${tone}`)}>
        <Icon size={15} />
        <div>
          {lines.map((l, i) => (
            <Inline key={i} as="p" text={l.replace(/^(⚠️|ℹ️|✅)\s*/, '')} />
          ))}
        </div>
      </blockquote>
    );
  }
  return (
    <blockquote>
      {lines.map((l, i) => (
        <Inline key={i} as="p" text={l} />
      ))}
    </blockquote>
  );
}

export function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const blocks = useMemo(() => parse(content), [content]);
  const lastIndex = blocks.length - 1;
  return (
    <div className="uv-md">
      {blocks.map((b, idx) => {
        const key = `${b.kind}-${idx}`;
        const tail = streaming && idx === lastIndex;
        switch (b.kind) {
          case 'code':
            return <CodeBlock key={key} code={b.code} lang={b.lang} live={tail && b.open} />;
          case 'table':
            return <Table key={key} head={b.head} rows={b.rows} />;
          case 'heading': {
            const Tag = `h${b.level}` as 'h1' | 'h2' | 'h3' | 'h4';
            return <Inline key={key} as={Tag} text={b.text} />;
          }
          case 'hr':
            return <hr key={key} />;
          case 'quote':
            return <Quote key={key} lines={b.lines} />;
          case 'list':
            return <React.Fragment key={key}>{renderList(b.items, b.ordered, key)}</React.Fragment>;
          case 'para':
            return (
              <p
                key={key}
                className={tail ? 'uv-caret' : undefined}
                dangerouslySetInnerHTML={{
                  __html: b.lines.map((l) => renderInline(l.trim())).join('<br />'),
                }}
              />
            );
          default:
            return null;
        }
      })}
      {streaming && blocks.length === 0 && <p className="uv-caret" />}
    </div>
  );
}
