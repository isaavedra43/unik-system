import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

/**
 * Web page → readable markdown.
 *
 * Readability finds the main article (like the browser reader mode), Turndown
 * converts its HTML to markdown. Whatever is left is still untrusted content —
 * callers wrap it with wrapUntrusted before the model sees it.
 */

export interface ExtractedPage {
  title: string;
  byline: string | null;
  markdown: string;
  /** True when Readability found a readable article (false = raw-ish fallback). */
  extracted: boolean;
  /** Absolute https links found on the page (for bounded crawling). */
  links: string[];
}

/** Same-origin https links, deduped, fragments stripped. */
export function extractLinks(html: string, baseUrl: string, limit = 50): string[] {
  const { document } = parseHTML(html);
  const base = new URL(baseUrl);
  const out = new Set<string>();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    try {
      const abs = new URL(href, base);
      if (abs.protocol !== 'https:' || abs.origin !== base.origin) continue;
      abs.hash = '';
      out.add(abs.toString());
      if (out.size >= limit) break;
    } catch {
      continue;
    }
  }
  return [...out];
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'nav', 'footer']);
// Links keep their target: the model cites sources with them.
turndown.keep(['a']);

const MAX_MARKDOWN_CHARS = 40_000;

export function extractReadable(html: string, url: string): ExtractedPage {
  const { document } = parseHTML(html);
  // Readability needs <base> context for relative links when present.
  const base = document.createElement('base');
  base.setAttribute('href', url);
  document.head?.appendChild(base);

  const article = new Readability(document as unknown as Document).parse();
  if (article && article.content) {
    const markdown = turndown
      .turndown(article.content)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (markdown.length >= 40) {
      return {
        title: (article.title ?? '').trim().slice(0, 300),
        byline: article.byline ? String(article.byline).trim().slice(0, 200) : null,
        markdown: markdown.slice(0, MAX_MARKDOWN_CHARS),
        extracted: true,
        links: extractLinks(html, url),
      };
    }
  }

  // Fallback: title + body text with tags stripped (dense but safe).
  const title = document.querySelector('title')?.textContent?.trim() ?? '';
  const bodyText = (document.body?.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MARKDOWN_CHARS);
  return { title: title.slice(0, 300), byline: null, markdown: bodyText, extracted: false, links: extractLinks(html, url) };
}
