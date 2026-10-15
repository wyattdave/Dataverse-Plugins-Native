import type { Issue, PluginSpec } from './spec.js';

/**
 * Offline syntax check for a Power Fx formula. It tokenizes and checks structure only; it never evaluates the
 * formula and does not know Dataverse table or function signatures, so passing is not proof the host accepts it.
 */

type TokenKind = 'identifier' | 'quotedIdentifier' | 'number' | 'string' | 'operator' | 'open' | 'close';

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  column: number;
}

const OPEN_TO_CLOSE: Readonly<Record<string, string>> = { '(': ')', '{': '}', '[': ']' };
const OPERATORS = ['<>', '<=', '>=', '&&', '||', '=', '<', '>', '+', '-', '*', '/', '^', '&', '!', '%', ',', ';', '.', ':', '@'];
/** Functions reported as unsupported in Dataverse low-code plug-ins. */
const UNSUPPORTED_CALLS = ['Set', 'UpdateContext', 'Navigate', 'Notify'];

class Scanner {
  index = 0;
  line = 1;
  column = 1;
  readonly tokens: Token[] = [];
  readonly issues: Issue[] = [];

  constructor(private readonly src: string) {}

  peek(offset = 0): string {
    return this.src[this.index + offset] ?? '';
  }

  advance(): string {
    const ch = this.src[this.index++] ?? '';
    if (ch === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  error(code: string, message: string, line: number, column: number): void {
    this.issues.push({ severity: 'error', code, message, line, column });
  }

  /** Scans tokens until end of input or, inside an interpolation island, the closing brace at depth zero. */
  scan(stopAtBrace = false): boolean {
    let depth = 0;
    while (this.index < this.src.length) {
      const ch = this.peek();
      const line = this.line;
      const column = this.column;
      if (/\s/.test(ch)) {
        this.advance();
      } else if (ch === '/' && this.peek(1) === '/') {
        while (this.index < this.src.length && this.peek() !== '\n') this.advance();
      } else if (ch === '/' && this.peek(1) === '*') {
        this.advance();
        this.advance();
        while (this.index < this.src.length && !(this.peek() === '*' && this.peek(1) === '/')) this.advance();
        if (this.index >= this.src.length) {
          this.error('FX_UNTERMINATED_COMMENT', 'Block comment is not closed with */.', line, column);
          return false;
        }
        this.advance();
        this.advance();
      } else if (ch === '$' && this.peek(1) === '"') {
        this.advance();
        if (!this.interpolated(line, column)) return false;
      } else if (ch === '"') {
        if (!this.quoted('"', 'string', 'FX_UNTERMINATED_STRING', 'Text string is not closed with ".', line, column)) return false;
      } else if (ch === "'") {
        if (!this.quoted("'", 'quotedIdentifier', 'FX_UNTERMINATED_NAME', "Quoted name is not closed with '.", line, column)) return false;
      } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(this.peek(1)))) {
        let text = '';
        while (/[0-9.]/.test(this.peek())) text += this.advance();
        if (/[eE]/.test(this.peek()) && /[0-9+-]/.test(this.peek(1))) {
          text += this.advance() + this.advance();
          while (/[0-9]/.test(this.peek())) text += this.advance();
        }
        if ((text.match(/\./g) ?? []).length > 1) {
          this.error('FX_BAD_NUMBER', `"${text}" is not a valid number.`, line, column);
        }
        this.tokens.push({ kind: 'number', text, line, column });
      } else if (/[A-Za-z_\u00C0-\uFFFF]/.test(ch)) {
        let text = '';
        while (/[A-Za-z0-9_\u00C0-\uFFFF]/.test(this.peek())) text += this.advance();
        this.tokens.push({ kind: 'identifier', text, line, column });
      } else if (Object.hasOwn(OPEN_TO_CLOSE, ch)) {
        this.advance();
        if (ch === '{') depth++;
        this.tokens.push({ kind: 'open', text: ch, line, column });
      } else if (ch === ')' || ch === '}' || ch === ']') {
        if (stopAtBrace && ch === '}' && depth === 0) {
          this.advance();
          return true;
        }
        this.advance();
        if (ch === '}') depth--;
        this.tokens.push({ kind: 'close', text: ch, line, column });
      } else {
        const op = OPERATORS.find((candidate) => this.src.startsWith(candidate, this.index));
        if (op === undefined) {
          this.advance();
          this.error('FX_UNEXPECTED_CHARACTER', `Unexpected character "${ch}".`, line, column);
          continue;
        }
        for (let i = 0; i < op.length; i++) this.advance();
        this.tokens.push({ kind: 'operator', text: op, line, column });
      }
    }
    return !stopAtBrace;
  }

  quoted(quote: string, kind: TokenKind, code: string, message: string, line: number, column: number): boolean {
    this.advance();
    let text = '';
    for (;;) {
      if (this.index >= this.src.length) {
        this.error(code, message, line, column);
        return false;
      }
      const ch = this.advance();
      if (ch === quote) {
        if (this.peek() !== quote) break;
        this.advance();
      }
      text += ch;
    }
    this.tokens.push({ kind, text, line, column });
    return true;
  }

  /** $"text {expression} text" — `{{` and `}}` are literal braces. */
  interpolated(line: number, column: number): boolean {
    this.advance();
    for (;;) {
      if (this.index >= this.src.length) {
        this.error('FX_UNTERMINATED_STRING', 'Interpolated string is not closed with ".', line, column);
        return false;
      }
      const ch = this.peek();
      if (ch === '"' && this.peek(1) === '"') {
        this.advance();
        this.advance();
      } else if (ch === '"') {
        this.advance();
        break;
      } else if ((ch === '{' && this.peek(1) === '{') || (ch === '}' && this.peek(1) === '}')) {
        this.advance();
        this.advance();
      } else if (ch === '{') {
        const islandLine = this.line;
        const islandColumn = this.column;
        this.advance();
        this.tokens.push({ kind: 'open', text: '(', line: islandLine, column: islandColumn });
        if (!this.scan(true)) {
          this.error('FX_UNTERMINATED_STRING', 'Interpolated expression is not closed with }.', islandLine, islandColumn);
          return false;
        }
        this.tokens.push({ kind: 'close', text: ')', line: this.line, column: this.column });
      } else {
        this.advance();
      }
    }
    this.tokens.push({ kind: 'string', text: '', line, column });
    return true;
  }
}

function checkBrackets(tokens: readonly Token[], issues: Issue[]): void {
  const stack: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'open') {
      stack.push(token);
    } else if (token.kind === 'close') {
      const open = stack.pop();
      if (open === undefined) {
        issues.push({ severity: 'error', code: 'FX_UNMATCHED_CLOSE', message: `"${token.text}" has no matching opening bracket.`, line: token.line, column: token.column });
        return;
      }
      if (OPEN_TO_CLOSE[open.text] !== token.text) {
        issues.push({
          severity: 'error',
          code: 'FX_MISMATCHED_BRACKET',
          message: `"${open.text}" at line ${open.line}, column ${open.column} is closed by "${token.text}".`,
          line: token.line,
          column: token.column,
        });
        return;
      }
    }
  }
  const open = stack.pop();
  if (open !== undefined) {
    issues.push({ severity: 'error', code: 'FX_UNCLOSED_BRACKET', message: `"${open.text}" is never closed.`, line: open.line, column: open.column });
  }
}

const isBinary = (t: Token | undefined): boolean =>
  t !== undefined && t.kind === 'operator' && !['!', '-', '@', '%'].includes(t.text);

function checkSequence(tokens: readonly Token[], issues: Issue[]): void {
  const last = tokens.at(-1);
  if (last !== undefined && last.kind === 'operator' && last.text !== ';' && last.text !== '%') {
    issues.push({ severity: 'error', code: 'FX_INCOMPLETE', message: `The formula ends with "${last.text}".`, line: last.line, column: last.column });
  }
  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1]!;
    const cur = tokens[i]!;
    if (isBinary(prev) && isBinary(cur) && prev.text !== ';') {
      issues.push({ severity: 'error', code: 'FX_OPERATOR_SEQUENCE', message: `"${prev.text}" is followed by "${cur.text}".`, line: cur.line, column: cur.column });
      return;
    }
    if (prev.kind === 'open' && isBinary(cur) && cur.text !== ';') {
      issues.push({ severity: 'error', code: 'FX_OPERATOR_SEQUENCE', message: `"${prev.text}" is followed by "${cur.text}".`, line: cur.line, column: cur.column });
      return;
    }
    if (prev.kind === 'operator' && prev.text === ',' && cur.kind === 'close') {
      issues.push({ severity: 'error', code: 'FX_TRAILING_COMMA', message: `Trailing "," before "${cur.text}".`, line: prev.line, column: prev.column });
      return;
    }
  }
}

const nameOf = (t: Token): string | undefined => (t.kind === 'identifier' || t.kind === 'quotedIdentifier' ? t.text : undefined);

function checkUsage(spec: PluginSpec, tokens: readonly Token[], issues: Issue[]): void {
  const names = new Set(tokens.map(nameOf).filter((n): n is string => n !== undefined));
  tokens.forEach((t, i) => {
    if (t.kind === 'identifier' && UNSUPPORTED_CALLS.includes(t.text) && tokens[i + 1]?.text === '(') {
      issues.push({ severity: 'warning', code: 'FX_UNSUPPORTED_FUNCTION', message: `${t.text}() is not supported in low-code plug-ins.`, line: t.line, column: t.column });
    }
  });
  if (spec.kind !== 'instant') {
    return;
  }
  for (const p of spec.parameters ?? []) {
    if (p.direction === 'input' && !names.has(p.name)) {
      issues.push({ severity: 'warning', code: 'FX_INPUT_UNUSED', message: `Input "${p.name}" is not used in the formula.`, path: '/formula' });
    }
    if (p.direction === 'output') {
      const assigned = tokens.some((t, i) => nameOf(t) === p.name && tokens[i + 1]?.text === ':');
      if (!assigned) {
        issues.push({
          severity: 'warning',
          code: 'FX_OUTPUT_UNASSIGNED',
          message: `Output "${p.name}" is never set. Return it in a record, e.g. { ${p.name}: ... }.`,
          path: '/formula',
        });
      }
    }
  }
}

export interface FormulaCheck {
  issues: Issue[];
  tokenCount: number;
}

export function checkFormula(spec: PluginSpec): FormulaCheck {
  const scanner = new Scanner(spec.formula);
  const complete = scanner.scan();
  const issues = [...scanner.issues];
  if (complete && issues.length === 0) {
    if (scanner.tokens.length === 0) {
      issues.push({ severity: 'error', code: 'FX_EMPTY', message: 'The formula has no expression (only whitespace or comments).', line: 1, column: 1 });
    }
    checkBrackets(scanner.tokens, issues);
    if (issues.length === 0) {
      checkSequence(scanner.tokens, issues);
    }
  }
  checkUsage(spec, scanner.tokens, issues);
  return { issues, tokenCount: scanner.tokens.length };
}
