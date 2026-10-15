import { escapePointer, type JsonObject, type JsonValue } from '../contracts/common.js';
import type { ReasonCode } from '../contracts/reasonCodes.js';

export class StrictJsonError extends Error {
  constructor(
    readonly code: ReasonCode,
    message: string,
    readonly path: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = 'StrictJsonError';
  }
}

export interface StrictJsonOptions {
  maxDepth?: number;
}

/**
 * RFC 8259 parser with adapter restrictions: duplicate keys, non-integer numbers,
 * unsafe integers, negative zero, and unpaired surrogates are rejected.
 */
export function parseStrictJson(text: string, options: StrictJsonOptions = {}): JsonValue {
  return new StrictParser(text, options.maxDepth ?? 64).parseDocument();
}

export function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
const HEX4_PATTERN = /^[0-9a-fA-F]{4}$/;

class StrictParser {
  private i = 0;

  constructor(
    private readonly s: string,
    private readonly maxDepth: number,
  ) {}

  parseDocument(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue('', 0);
    this.skipWhitespace();
    if (this.i !== this.s.length) {
      throw this.error('JSON_SYNTAX_ERROR', 'Unexpected content after the JSON document.', '');
    }
    return value;
  }

  private error(code: ReasonCode, message: string, path: string): StrictJsonError {
    return new StrictJsonError(code, `${message} (offset ${this.i})`, path, this.i);
  }

  private skipWhitespace(): void {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        this.i++;
      } else {
        break;
      }
    }
  }

  private parseValue(path: string, depth: number): JsonValue {
    if (depth > this.maxDepth) {
      throw this.error('JSON_NESTING_TOO_DEEP', `Nesting exceeds ${this.maxDepth} levels.`, path);
    }
    const c = this.s[this.i];
    switch (c) {
      case '{':
        return this.parseObject(path, depth);
      case '[':
        return this.parseArray(path, depth);
      case '"':
        return this.parseString(path);
      case 't':
        return this.parseKeyword('true', true, path);
      case 'f':
        return this.parseKeyword('false', false, path);
      case 'n':
        return this.parseKeyword('null', null, path);
      default:
        if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
          return this.parseNumber(path);
        }
        throw this.error('JSON_SYNTAX_ERROR', 'Unexpected character or end of input.', path);
    }
  }

  private parseKeyword<T extends JsonValue>(word: string, value: T, path: string): T {
    if (!this.s.startsWith(word, this.i)) {
      throw this.error('JSON_SYNTAX_ERROR', 'Invalid literal.', path);
    }
    this.i += word.length;
    return value;
  }

  private parseObject(path: string, depth: number): JsonObject {
    this.i++;
    const out: JsonObject = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.s[this.i] !== '"') {
        throw this.error('JSON_SYNTAX_ERROR', 'Expected a property name.', path);
      }
      const key = this.parseString(path);
      const childPath = `${path}/${escapePointer(key)}`;
      if (seen.has(key)) {
        throw this.error('JSON_DUPLICATE_KEY', 'Duplicate property name.', childPath);
      }
      seen.add(key);
      this.skipWhitespace();
      if (this.s[this.i] !== ':') {
        throw this.error('JSON_SYNTAX_ERROR', 'Expected a colon.', childPath);
      }
      this.i++;
      this.skipWhitespace();
      const value = this.parseValue(childPath, depth + 1);
      // defineProperty keeps keys such as "__proto__" as plain data instead of mutating the prototype.
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
      this.skipWhitespace();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === '}') {
        this.i++;
        return out;
      }
      throw this.error('JSON_SYNTAX_ERROR', 'Expected a comma or closing brace.', path);
    }
  }

  private parseArray(path: string, depth: number): JsonValue[] {
    this.i++;
    const out: JsonValue[] = [];
    this.skipWhitespace();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      out.push(this.parseValue(`${path}/${out.length}`, depth + 1));
      this.skipWhitespace();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === ']') {
        this.i++;
        return out;
      }
      throw this.error('JSON_SYNTAX_ERROR', 'Expected a comma or closing bracket.', path);
    }
  }

  private parseString(path: string): string {
    this.i++;
    let out = '';
    let start = this.i;
    for (;;) {
      if (this.i >= this.s.length) {
        throw this.error('JSON_SYNTAX_ERROR', 'Unterminated string.', path);
      }
      const c = this.s.charCodeAt(this.i);
      if (c === 0x22) {
        out += this.s.slice(start, this.i);
        this.i++;
        break;
      }
      if (c === 0x5c) {
        out += this.s.slice(start, this.i);
        const escape = this.s[this.i + 1];
        switch (escape) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = this.s.slice(this.i + 2, this.i + 6);
            if (!HEX4_PATTERN.test(hex)) {
              throw this.error('JSON_SYNTAX_ERROR', 'Invalid unicode escape.', path);
            }
            out += String.fromCharCode(parseInt(hex, 16));
            this.i += 4;
            break;
          }
          default:
            throw this.error('JSON_SYNTAX_ERROR', 'Invalid escape sequence.', path);
        }
        this.i += 2;
        start = this.i;
        continue;
      }
      if (c < 0x20) {
        throw this.error('JSON_SYNTAX_ERROR', 'Unescaped control character in string.', path);
      }
      this.i++;
    }
    if (!isWellFormedUtf16(out)) {
      throw this.error('JSON_INVALID_UNICODE', 'String contains an unpaired surrogate.', path);
    }
    return out;
  }

  private parseNumber(path: string): number {
    NUMBER_PATTERN.lastIndex = this.i;
    const match = NUMBER_PATTERN.exec(this.s);
    if (match === null) {
      throw this.error('JSON_SYNTAX_ERROR', 'Invalid number.', path);
    }
    const text = match[0];
    this.i += text.length;
    if (match[1] !== undefined || match[2] !== undefined || text === '-0') {
      throw this.error(
        'JSON_UNSUPPORTED_NUMBER',
        'Contract v1 numbers must be integers without fraction, exponent, or negative zero.',
        path,
      );
    }
    const value = Number(text);
    if (!Number.isSafeInteger(value)) {
      throw this.error('JSON_UNSUPPORTED_NUMBER', 'Integer is outside the safe integer range.', path);
    }
    return value;
  }
}
