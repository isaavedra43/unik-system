/**
 * Tiny syntax highlighter for chat code blocks — no dependencies, no WASM
 * (the app CSP has no 'wasm-unsafe-eval'). Tokenizes a line-agnostic stream
 * into spans for keywords, strings, numbers, comments and function calls.
 * Output is HTML-escaped; only our own <span class="uv-tok-*"> tags are added.
 */

const KEYWORDS: Record<string, string[]> = {
  js: [
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'new',
    'class',
    'extends',
    'import',
    'from',
    'export',
    'default',
    'async',
    'await',
    'try',
    'catch',
    'finally',
    'throw',
    'typeof',
    'instanceof',
    'in',
    'of',
    'this',
    'null',
    'undefined',
    'true',
    'false',
    'interface',
    'type',
    'enum',
    'implements',
    'public',
    'private',
    'protected',
    'readonly',
    'static',
    'as',
    'yield',
    'void',
    'delete',
    'keyof',
    'satisfies',
  ],
  py: [
    'def',
    'return',
    'if',
    'elif',
    'else',
    'for',
    'while',
    'in',
    'not',
    'and',
    'or',
    'import',
    'from',
    'as',
    'class',
    'try',
    'except',
    'finally',
    'raise',
    'with',
    'lambda',
    'yield',
    'None',
    'True',
    'False',
    'pass',
    'break',
    'continue',
    'global',
    'async',
    'await',
    'self',
    'is',
  ],
  sql: [
    'select',
    'from',
    'where',
    'and',
    'or',
    'not',
    'insert',
    'into',
    'values',
    'update',
    'set',
    'delete',
    'create',
    'table',
    'alter',
    'drop',
    'join',
    'left',
    'right',
    'inner',
    'outer',
    'on',
    'group',
    'by',
    'order',
    'having',
    'limit',
    'offset',
    'as',
    'distinct',
    'count',
    'sum',
    'avg',
    'min',
    'max',
    'case',
    'when',
    'then',
    'else',
    'end',
    'null',
    'is',
    'in',
    'like',
    'between',
    'union',
    'all',
    'exists',
    'index',
    'primary',
    'key',
    'references',
    'default',
    'with',
  ],
  sh: [
    'if',
    'then',
    'else',
    'fi',
    'for',
    'do',
    'done',
    'while',
    'case',
    'esac',
    'function',
    'in',
    'export',
    'echo',
    'cd',
    'sudo',
    'npm',
    'npx',
    'node',
    'git',
    'pip',
    'python',
    'python3',
    'curl',
    'ls',
    'cat',
    'grep',
    'mkdir',
    'rm',
    'cp',
    'mv',
    'set',
    'unset',
    'local',
    'return',
  ],
  css: ['important', 'media', 'supports', 'keyframes', 'import', 'from', 'to'],
};

const ALIASES: Record<string, keyof typeof KEYWORDS | 'json' | 'html'> = {
  js: 'js',
  javascript: 'js',
  jsx: 'js',
  ts: 'js',
  typescript: 'js',
  tsx: 'js',
  mjs: 'js',
  cjs: 'js',
  py: 'py',
  python: 'py',
  sql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  sh: 'sh',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  console: 'sh',
  terminal: 'sh',
  css: 'css',
  scss: 'css',
  json: 'json',
  html: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const span = (cls: string, text: string) => `<span class="uv-tok-${cls}">${esc(text)}</span>`;

export function normalizeLang(lang: string | undefined): string {
  const l = (lang ?? '').trim().toLowerCase();
  return ALIASES[l] ?? l;
}

export function highlight(code: string, lang: string | undefined): string {
  const kind = normalizeLang(lang);
  if (kind === 'html') return highlightMarkup(code);
  const words = new Set(
    (
      KEYWORDS[kind as keyof typeof KEYWORDS] ?? (kind === 'json' ? ['true', 'false', 'null'] : [])
    ).map((w) => (kind === 'sql' ? w.toLowerCase() : w))
  );
  const lineComment =
    kind === 'py' || kind === 'sh'
      ? '#'
      : kind === 'sql'
        ? '--'
        : kind === 'json' || kind === 'css'
          ? null
          : '//';
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    // block comments /* */
    if (ch === '/' && code[i + 1] === '*' && kind !== 'py' && kind !== 'sh') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += span('c', code.slice(i, stop));
      i = stop;
      continue;
    }
    // line comments
    if (
      lineComment &&
      code.startsWith(lineComment, i) &&
      !(lineComment === '#' && kind === 'sh' && code[i + 1] === '!')
    ) {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += span('c', code.slice(i, stop));
      i = stop;
      continue;
    }
    // strings
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n && code[j] !== ch) {
        if (code[j] === '\\') j++;
        if (code[j] === '\n' && ch !== '`') break;
        j++;
      }
      const stop = Math.min(j + 1, n);
      out += span('s', code.slice(i, stop));
      i = stop;
      continue;
    }
    // numbers
    if (/[0-9]/.test(ch) && !/[\w$]/.test(code[i - 1] ?? '')) {
      const m = /^(0x[0-9a-fA-F]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(code.slice(i));
      if (m) {
        out += span('n', m[0]);
        i += m[0].length;
        continue;
      }
    }
    // identifiers / keywords / calls
    if (/[A-Za-z_$@]/.test(ch)) {
      const m = /^[A-Za-z_$@][\w$-]*/.exec(code.slice(i));
      const word = m ? m[0] : ch;
      const key = kind === 'sql' ? word.toLowerCase() : word;
      if (words.has(key)) out += span('k', word);
      else if (code[i + word.length] === '(') out += span('f', word);
      else out += esc(word);
      i += word.length;
      continue;
    }
    if (/[{}()[\];,.:=<>+\-*/%!&|?]/.test(ch)) {
      out += span('p', ch);
      i++;
      continue;
    }
    out += esc(ch);
    i++;
  }
  return out;
}

function highlightMarkup(code: string): string {
  // Small state machine (tag → name → attributes → values): regex passes over
  // already-inserted spans would re-wrap our own class="…" attributes.
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    if (code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4);
      const stop = end === -1 ? n : end + 3;
      out += span('c', code.slice(i, stop));
      i = stop;
      continue;
    }
    if (code[i] === '<' && /[/!A-Za-z]/.test(code[i + 1] ?? '')) {
      out += span('p', code[i] === '<' && code[i + 1] === '/' ? '</' : '<');
      i += code[i + 1] === '/' ? 2 : 1;
      const name = /^[!\w-]+/.exec(code.slice(i))?.[0] ?? '';
      if (name) {
        out += span('k', name);
        i += name.length;
      }
      while (i < n && code[i] !== '>') {
        const ch = code[i];
        if (ch === '"' || ch === "'") {
          const end = code.indexOf(ch, i + 1);
          const stop = end === -1 ? n : end + 1;
          out += span('s', code.slice(i, stop));
          i = stop;
        } else if (/[A-Za-z_:@-]/.test(ch)) {
          const attr = /^[\w:@.-]+/.exec(code.slice(i))?.[0] ?? ch;
          out += span('f', attr);
          i += attr.length;
        } else {
          out += esc(ch);
          i++;
        }
      }
      if (i < n) {
        out += span('p', '>');
        i++;
      }
      continue;
    }
    out += esc(code[i]);
    i++;
  }
  return out;
}
