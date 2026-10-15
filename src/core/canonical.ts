import { createHash } from 'node:crypto';
import { ordinalCompare } from '../contracts/common.js';
import { isWellFormedUtf16 } from './strictJson.js';

export const CANONICALIZATION_VERSION = 'adapter.c14n/v1';

/**
 * adapter.c14n/v1: UTF-8, no insignificant whitespace, object keys recursively sorted by ordinal
 * UTF-16 code-unit order, arrays kept in order, safe integers only, strings escaped exactly as
 * ECMAScript JSON.stringify (well-formed). Undefined values and non-plain objects are rejected.
 */
export function canonicalize(value: unknown): string {
  return write(value, '');
}

function write(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new TypeError(`Canonicalization supports safe integers only (at ${path || '/'}).`);
      }
      return String(value);
    case 'string':
      if (!isWellFormedUtf16(value)) {
        throw new TypeError(`Canonicalization rejects unpaired surrogates (at ${path || '/'}).`);
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => write(item, `${path}/${i}`)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`Canonicalization supports plain objects only (at ${path || '/'}).`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(ordinalCompare);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${write(record[k], `${path}/${k}`)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`Canonicalization does not support ${typeof value} (at ${path || '/'}).`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  const hash = createHash('sha256');
  if (typeof data === 'string') {
    hash.update(data, 'utf8');
  } else {
    hash.update(data);
  }
  return hash.digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** Only declared normalization: CRLF/CR to LF when lineEndings=lf. No trimming, reformatting, or Unicode normalization. */
export function normalizeFormulaSource(text: string, lineEndings: 'lf' | 'preserve'): string {
  return lineEndings === 'lf' ? text.replace(/\r\n?/g, '\n') : text;
}
