/**
 * Phase 22: a real regex tokenizer producing syntax tokens for the
 * code editor (TypeScript/JavaScript, C#, Python, Kotlin). Tokens
 * carry exact offsets so editors can color precisely, and an HTML
 * renderer (fully escaped) is provided for web previews.
 */

export type TokenType = 'keyword' | 'string' | 'comment' | 'number' | 'type' | 'function' | 'operator' | 'plain';

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

export type SupportedLanguage = 'typescript' | 'csharp' | 'python' | 'kotlin';

const KEYWORDS: Record<SupportedLanguage, Set<string>> = {
  typescript: new Set('abstract async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while yield'.split(' ')),
  csharp: new Set('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while'.split(' ')),
  python: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(' ')),
  kotlin: new Set('as break class companion continue data do else false for fun if in init interface internal is it lateinit new null object open operator out override package private protected public reified return sealed set suspend switch this throw to true try typealias val var when while'.split(' '))
};

const TOKEN_RE =
  /(?<comment>\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?<number>\b\d+(?:\.\d+)?\b)|(?<ident>[A-Za-z_$][A-Za-z0-9_$]*)|(?<ws>\s+)|(?<other>.)/gs;

export function languageForPath(filePath: string): SupportedLanguage | null {
  const lower = filePath.toLowerCase();
  if (/\.(ts|tsx|js|jsx|mjs)$/.test(lower)) return 'typescript';
  if (/\.cs$/.test(lower)) return 'csharp';
  if (/\.py$/.test(lower)) return 'python';
  if (/\.kt$/.test(lower)) return 'kotlin';
  return null;
}

export function tokenize(source: string, language: SupportedLanguage): Token[] {
  const keywords = KEYWORDS[language];
  const tokens: Token[] = [];
  // Python has no // comments; strip that alternative by post-checking.
  for (const match of source.matchAll(TOKEN_RE)) {
    const text = match[0];
    const start = match.index ?? 0;
    const groups = match.groups ?? {};
    let type: TokenType = 'plain';
    if (groups.comment) {
      type = language === 'python' && text.startsWith('//') ? 'operator' : 'comment';
    } else if (groups.string) type = 'string';
    else if (groups.number) type = 'number';
    else if (groups.ident) {
      if (keywords.has(text)) type = 'keyword';
      else if (/^[A-Z]/.test(text)) type = 'type';
      else {
        // function call: identifier immediately followed by '('
        const next = source[start + text.length];
        type = next === '(' ? 'function' : 'plain';
      }
    } else if (groups.other) type = 'operator';
    tokens.push({ type, text, start, end: start + text.length });
  }
  return tokens;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function highlightToHtml(source: string, language: SupportedLanguage): string {
  return tokenize(source, language)
    .map((t) => (t.type === 'plain' ? escapeHtml(t.text) : `<span class="tok-${t.type}">${escapeHtml(t.text)}</span>`))
    .join('');
}
