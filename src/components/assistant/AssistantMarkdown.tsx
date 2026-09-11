'use client';

import React from 'react';
import { colorForStatusLabel } from '@/modules/ai/generators/status-tone';

/**
 * Minimal markdown renderer for the AI assistant.
 * Supports: headings, bold, italic, inline code, code blocks, lists, tables, links, blockquotes.
 * This avoids adding a heavy dependency like react-markdown.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#39;');
}

function renderInline(text: string): string {
  let html = escapeHtml(text);
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="assistant-md-code">$1</code>');
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="assistant-md-link">$1</a>'
  );
  return html;
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

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const Tag = `h${Math.min(level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Tag key={key++} className="assistant-md-heading" dangerouslySetInnerHTML={{ __html: renderInline(text) }} />
      );
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

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} className="assistant-md-list">
          {items.map((item, idx) => (
            <li key={idx} dangerouslySetInnerHTML={{ __html: renderInline(item) }} />
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
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
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(
        <p key={key++} className="assistant-md-p" dangerouslySetInnerHTML={{ __html: renderInline(paraLines.join(' ')) }} />
      );
    }
  }

  return <div className="assistant-md">{blocks}</div>;
}
