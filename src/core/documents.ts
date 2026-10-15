import { readFile, stat } from 'node:fs/promises';
import { diag, type Diagnostic, type JsonValue } from '../contracts/common.js';
import { validateSchema, type Schema } from '../contracts/schema.js';
import { sha256Hex } from './canonical.js';
import { parseStrictJson, StrictJsonError } from './strictJson.js';

export const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;

export interface ParsedDocument<T> {
  value: T | undefined;
  diagnostics: Diagnostic[];
}

export interface LoadedText {
  text: string | undefined;
  bytesSha256: string | undefined;
  diagnostics: Diagnostic[];
}

/** Parses strictly, checks the schemaVersion first, then validates the full schema. */
export function parseDocument<T>(text: string, schema: Schema, expectedVersion: string, label: string): ParsedDocument<T> {
  let value: JsonValue;
  try {
    value = parseStrictJson(text);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      return { value: undefined, diagnostics: [diag(error.code, 'error', 'schema', `${label}: ${error.message}`, error.path)] };
    }
    throw error;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && value['schemaVersion'] !== expectedVersion) {
    return {
      value: undefined,
      diagnostics: [
        diag('SCHEMA_VERSION_UNSUPPORTED', 'error', 'schema', `${label}: schemaVersion must be exactly "${expectedVersion}".`, '/schemaVersion'),
      ],
    };
  }
  const diagnostics = validateSchema(value, schema);
  return diagnostics.length === 0 ? { value: value as T, diagnostics } : { value: undefined, diagnostics };
}

/** Bounded, fatal UTF-8 read. A leading BOM is ignored; the file bytes are hashed for evidence. */
export async function readTextFile(path: string, label: string, maxBytes = DEFAULT_MAX_INPUT_BYTES): Promise<LoadedText> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return failText('INPUT_FILE_UNREADABLE', `${label}: path is not a regular file.`);
    }
    if (info.size > maxBytes) {
      return failText('INPUT_TOO_LARGE', `${label}: file exceeds ${maxBytes} bytes.`);
    }
    const bytes = await readFile(path);
    if (bytes.byteLength > maxBytes) {
      return failText('INPUT_TOO_LARGE', `${label}: file exceeds ${maxBytes} bytes.`);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return failText('INPUT_INVALID_UTF8', `${label}: file is not valid UTF-8.`);
    }
    return { text, bytesSha256: sha256Hex(bytes), diagnostics: [] };
  } catch {
    return failText('INPUT_FILE_UNREADABLE', `${label}: file could not be read.`);
  }
}

function failText(code: 'INPUT_FILE_UNREADABLE' | 'INPUT_TOO_LARGE' | 'INPUT_INVALID_UTF8', message: string): LoadedText {
  return { text: undefined, bytesSha256: undefined, diagnostics: [diag(code, 'error', 'schema', message)] };
}
