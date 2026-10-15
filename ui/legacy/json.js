// JSON helpers for the editor. Formatting is token-based so it never drops duplicate keys or rewrites
// numbers/strings; the authoritative strict validation always happens on the adapter side.

const WS = new Set([' ', '\t', '\n', '\r']);

export function escapePointerSegment(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Parses JSON while recording the source range of every value by JSON pointer and the first duplicate key.
 * Returns { value, positions, duplicate, error } where error is { message, offset } or null.
 */
export function analyzeJson(text) {
  let i = 0;
  let duplicate = null;
  const positions = new Map();
  const fail = (message) => {
    const error = new Error(message);
    error.offset = i;
    throw error;
  };
  const ws = () => {
    while (i < text.length && WS.has(text[i])) i++;
  };
  const string = () => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      i++;
    }
    if (i >= text.length) fail('Unterminated string');
    i++;
    try {
      return JSON.parse(text.slice(start, i));
    } catch {
      i = start;
      return fail('Invalid string escape');
    }
  };
  const value = (pointer, depth) => {
    if (depth > 200) fail('Nesting too deep');
    ws();
    const start = i;
    const c = text[i];
    let result;
    if (c === '{') {
      i++;
      result = {};
      const seen = new Set();
      ws();
      if (text[i] === '}') {
        i++;
      } else {
        for (;;) {
          ws();
          if (text[i] !== '"') fail('Expected a property name');
          const key = string();
          const child = `${pointer}/${escapePointerSegment(key)}`;
          if (seen.has(key) && duplicate === null) duplicate = child;
          seen.add(key);
          ws();
          if (text[i] !== ':') fail('Expected ":"');
          i++;
          Object.defineProperty(result, key, { value: value(child, depth + 1), enumerable: true, writable: true, configurable: true });
          ws();
          if (text[i] === ',') {
            i++;
            continue;
          }
          if (text[i] === '}') {
            i++;
            break;
          }
          fail('Expected "," or "}"');
        }
      }
    } else if (c === '[') {
      i++;
      result = [];
      ws();
      if (text[i] === ']') {
        i++;
      } else {
        for (;;) {
          result.push(value(`${pointer}/${result.length}`, depth + 1));
          ws();
          if (text[i] === ',') {
            i++;
            continue;
          }
          if (text[i] === ']') {
            i++;
            break;
          }
          fail('Expected "," or "]"');
        }
      }
    } else if (c === '"') {
      result = string();
    } else {
      const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
      if (match === null) fail(i >= text.length ? 'Unexpected end of input' : 'Unexpected token');
      i += match[0].length;
      result = JSON.parse(match[0]);
    }
    positions.set(pointer, { start, end: i });
    return result;
  };
  try {
    const result = value('', 0);
    ws();
    if (i < text.length) fail('Unexpected content after the JSON document');
    return { value: result, positions, duplicate, error: null };
  } catch (error) {
    return { value: undefined, positions, duplicate, error: { message: error.message, offset: error.offset ?? i } };
  }
}

/** Re-indents valid JSON by tokens only; string and number text is copied verbatim. */
export function reindentJson(text, indent = '  ') {
  const analysis = analyzeJson(text);
  if (analysis.error !== null) return { error: analysis.error };
  let out = '';
  let depth = 0;
  let i = 0;
  const newline = () => `\n${indent.repeat(depth)}`;
  while (i < text.length) {
    const c = text[i];
    if (WS.has(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      while (text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      out += text.slice(start, i);
      continue;
    }
    if (c === '{' || c === '[') {
      let j = i + 1;
      while (j < text.length && WS.has(text[j])) j++;
      if (text[j] === (c === '{' ? '}' : ']')) {
        out += c + text[j];
        i = j + 1;
        continue;
      }
      depth++;
      out += c + newline();
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      out += newline() + c;
      i++;
      continue;
    }
    if (c === ',') {
      out += `,${newline()}`;
      i++;
      continue;
    }
    if (c === ':') {
      out += ': ';
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && !WS.has(text[i]) && !',:{}[]"'.includes(text[i])) i++;
    out += text.slice(start, i);
  }
  return { text: `${out}\n` };
}

/** Finds the source range for a JSON pointer, falling back to the nearest existing parent. */
export function locatePointer(text, pointer) {
  const { positions, error } = analyzeJson(text);
  let current = pointer;
  let exact = true;
  for (;;) {
    const hit = positions.get(current);
    if (hit !== undefined) return { ...hit, exact };
    if (current === '') break;
    current = current.slice(0, current.lastIndexOf('/'));
    exact = false;
  }
  if (error !== null) return { start: error.offset, end: error.offset, exact: false };
  return null;
}

export function lineAndColumn(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}
