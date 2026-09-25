'use client';

import React from 'react';
import { colorForStatusLabel } from '@/modules/ai/generators/status-tone';
import { renderInline } from './markdown-inline';

/**
 * Minimal markdown renderer for the AI assistant.
 * Supports: headings, bold, italic, inline code, code blocks, lists, tables, links, blockquotes.
 * This avoids adding a heavy dependency like react-markdown.
 * Inline formatting + link sanitizing live in ./markdown-inline (pure, testable).
 */

const BULLET_RE = /^(\s*)[-*•]\s+/;
const ORDERED_RE = /^(\s*)\d+[.)]\s+/;

/** Nested bullet lists: indentation of 2+ spaces opens a sub-list (what models write for sub-points). */
function renderBulletList(items: Array<{ indent: number; text: string }>, keyBase: number): React.ReactNode {
  const base = items[0]?.indent ?? 0;
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    const children: Array<{ indent: number; text: string }> = [];
    let j = i + 1;
    while (j < items.length && items[j].indent > base) {
      children.push(items[j]);
      j++;
    }
    nodes.push(
      <li key={`${keyBase}-${i}`}>
        <span dangerouslySetInnerHTML={{ __html: renderInline(item.text) }} />
        {children.length > 0 && renderBulletList(children, keyBase * 31 + i + 1)}
      </li>
    );
    i = j;
  }
  return <ul className="assistant-md-list">{nodes}</ul>;
}

export function AssistantMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block ```
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push(
        <pre key={key++} className="assistant-md-pre">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Table (line starts with | and next line is |---|)
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\|[\s-:]+\|/.test(lines[i + 1].trim())) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const header = tableLines[0].split('|').slice(1, -1).map((c) => c.trim());
      const rows = tableLines.slice(2).map((r) => r.split('|').slice(1, -1).map((c) => c.trim()));
      blocks.push(
        <div key={key++} className="assistant-md-table-wrap">
          <table className="assistant-md-table">
            <thead>
              <tr>
                {header.map((h, idx) => (
                  <th key={idx} dangerouslySetInnerHTML={{ __html: renderInline(h) }} />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => {
                    // Color known status words (Cerrado, Pendiente...) the same way every other
                    // report format does — only when the cell IS the status word, not a
                    // substring match, so it never mis-colors an address or customer name.
                    const color = colorForStatusLabel(c);
                    return color ? (
                      <td key={ci}>
                        <span
                          className="assistant-md-table-status"
                          style={{ color }}
                          dangerouslySetInnerHTML={{ __html: renderInline(c) }}
                        />
                      </td>
                    ) : (
                      <td key={ci} dangerouslySetInnerHTML={{ __html: renderInline(c) }} />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Headings (# … ####) — rendered as h3/h4 with a size per level so "## Resumen" and
    // "### Recolección — 20" read as sections and sub-sections, not as body text.
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 4);
      const text = headingMatch[2];
      const Tag = (level <= 2 ? 'h3' : 'h4') as 'h3' | 'h4';
      blocks.push(
        <Tag key={key++} className={`assistant-md-heading assistant-md-heading-${level}`} dangerouslySetInnerHTML={{ __html: renderInline(text) }} />
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="assistant-md-hr" />);
      i++;
      continue;
    }

    // Blockquote
    if (line.trim().startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().slice(1).trim());
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="assistant-md-quote" dangerouslySetInnerHTML={{ __html: renderInline(quoteLines.join(' ')) }} />
      );
      continue;
    }

    // Unordered list (with nesting by indentation)
    if (BULLET_RE.test(line)) {
      const items: Array<{ indent: number; text: string }> = [];
      while (i < lines.length && BULLET_RE.test(lines[i])) {
        const m = lines[i].match(BULLET_RE);
        items.push({ indent: (m?.[1] ?? '').replace(/\t/g, '  ').length, text: lines[i].replace(BULLET_RE, '') });
        i++;
      }
      const listKey = key++;
      blocks.push(<React.Fragment key={listKey}>{renderBulletList(items, listKey)}</React.Fragment>);
      continue;
    }

    // Ordered list ("1. " and "1) ")
    if (ORDERED_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && ORDERED_RE.test(lines[i])) {
        items.push(lines[i].replace(ORDERED_RE, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} className="assistant-md-list">
          {items.map((item, idx) => (
            <li key={idx} dangerouslySetInnerHTML={{ __html: renderInline(item) }} />
          ))}
        </ol>
      );
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (collect consecutive non-empty, non-special lines)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !lines[i].trim().startsWith('|') &&
      !lines[i].trim().startsWith('#') &&
      !lines[i].trim().startsWith('>') &&
      !BULLET_RE.test(lines[i]) &&
      !ORDERED_RE.test(lines[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      // A line break inside a paragraph is a line break (chat style), not a soft join:
      // "Folio: 23354\nCliente: …" must stay on two lines.
      blocks.push(
        <p key={key++} className="assistant-md-p" dangerouslySetInnerHTML={{ __html: paraLines.map((l) => renderInline(l.trim())).join('<br />') }} />
      );
    }
  }

  return <div className="assistant-md">{blocks}</div>;
}
