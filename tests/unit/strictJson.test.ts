import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStrictJson, StrictJsonError } from '../../src/core/strictJson.js';

function code(text: string): string | undefined {
  try {
    parseStrictJson(text);
    return undefined;
  } catch (error) {
    assert.ok(error instanceof StrictJsonError);
    return error.code;
  }
}

describe('strict JSON parser (T01)', () => {
  it('parses ordinary documents', () => {
    assert.deepEqual(parseStrictJson(' {"a":[1,true,null,"x"],"b":{}} '), { a: [1, true, null, 'x'], b: {} });
  });

  it('rejects duplicate keys at any depth, with a JSON pointer', () => {
    assert.equal(code('{"a":1,"a":2}'), 'JSON_DUPLICATE_KEY');
    try {
      parseStrictJson('{"x":{"y":1,"y":2}}');
      assert.fail('expected failure');
    } catch (error) {
      assert.ok(error instanceof StrictJsonError);
      assert.equal(error.path, '/x/y');
    }
  });

  it('treats keys that only differ after unescaping as duplicates', () => {
    assert.equal(code('{"a":1,"\\u0061":2}'), 'JSON_DUPLICATE_KEY');
  });

  it('rejects fractions, exponents, negative zero, and unsafe integers', () => {
    assert.equal(code('{"n":1.5}'), 'JSON_UNSUPPORTED_NUMBER');
    assert.equal(code('{"n":1e3}'), 'JSON_UNSUPPORTED_NUMBER');
    assert.equal(code('{"n":-0}'), 'JSON_UNSUPPORTED_NUMBER');
    assert.equal(code('{"n":9007199254740993}'), 'JSON_UNSUPPORTED_NUMBER');
    assert.deepEqual(parseStrictJson('{"n":-12}'), { n: -12 });
  });

  it('rejects unpaired surrogates but accepts valid pairs', () => {
    assert.equal(code('"\\ud800"'), 'JSON_INVALID_UNICODE');
    assert.equal(code('"\\udc00x"'), 'JSON_INVALID_UNICODE');
    assert.equal(parseStrictJson('"\\ud83d\\ude00"'), '😀');
  });

  it('rejects syntax errors, trailing content, comments, and raw control characters', () => {
    assert.equal(code('{"a":1,}'), 'JSON_SYNTAX_ERROR');
    assert.equal(code('{"a":1} x'), 'JSON_SYNTAX_ERROR');
    assert.equal(code('// c\n{}'), 'JSON_SYNTAX_ERROR');
    assert.equal(code('"a\u0001b"'), 'JSON_SYNTAX_ERROR');
    assert.equal(code("{'a':1}"), 'JSON_SYNTAX_ERROR');
  });

  it('keeps "__proto__" as plain data without mutating prototypes', () => {
    const value = parseStrictJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.ok(Object.hasOwn(value, '__proto__'));
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });

  it('bounds nesting depth', () => {
    assert.equal(code(`${'['.repeat(70)}${']'.repeat(70)}`), 'JSON_NESTING_TOO_DEEP');
  });
});
