import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalize, hashCanonical, normalizeFormulaSource, sha256Hex } from '../../src/core/canonical.js';
import { buildDesiredState } from '../../src/core/planner.js';
import { parseStrictJson } from '../../src/core/strictJson.js';
import { clone, exampleSpec } from '../helpers.js';

describe('canonicalization and hashing (T02)', () => {
  it('pins the canonical serializer output and hash (golden)', () => {
    const value = parseStrictJson('{"b":"\\u0001\\"\\\\/\u00e9\ud83d\ude00","a":[3,1],"A":true,"n":-42}');
    const expected = '{"A":true,"a":[3,1],"b":"\\u0001\\"\\\\/\u00e9\ud83d\ude00","n":-42}';
    assert.equal(canonicalize(value), expected);
    // Independently cross-checked with .NET SHA256 over the same UTF-8 bytes.
    assert.equal(sha256Hex(expected), '1108d375af686b61af7be47a569880841e1844f234e57aeed9619747ee382387');
  });

  it('pins the example spec hash (golden)', async () => {
    assert.equal(buildDesiredState(await exampleSpec()).specSha256, 'df73b1d105a50058e3674b8da82aeffb3bd5723fd11437fd463a0375f83c428f');
  });

  it('is independent of key order and JSON formatting', () => {
    const a = parseStrictJson('{"x":1,"y":{"b":2,"a":[1,2]}}');
    const b = parseStrictJson('{\n  "y": { "a": [1, 2], "b": 2 },\n  "x": 1\n}');
    assert.equal(hashCanonical(a), hashCanonical(b));
  });

  it('retains array order', () => {
    assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  });

  it('rejects floats, negative zero, undefined, and non-plain objects', () => {
    assert.throws(() => canonicalize({ n: 1.5 }));
    assert.throws(() => canonicalize({ n: -0 }));
    assert.throws(() => canonicalize({ n: undefined }));
    assert.throws(() => canonicalize({ d: new Date(0) }));
  });

  it('normalizes only declared line endings', () => {
    assert.equal(normalizeFormulaSource('a\r\nb\rc\n', 'lf'), 'a\nb\nc\n');
    assert.equal(normalizeFormulaSource('a\r\nb', 'preserve'), 'a\r\nb');
    assert.equal(normalizeFormulaSource('  a  \t', 'lf'), '  a  \t');
  });

  it('treats CRLF and LF as equivalent under lineEndings=lf', async () => {
    const lf = await exampleSpec();
    lf.formula.text = 'Amount *\nRate';
    const crlf = clone(lf);
    crlf.formula.text = 'Amount *\r\nRate';
    assert.equal(buildDesiredState(lf).specSha256, buildDesiredState(crlf).specSha256);
    assert.equal(buildDesiredState(lf).sourceSha256, buildDesiredState(crlf).sourceSha256);
  });

  it('keeps CRLF significant under lineEndings=preserve', async () => {
    const lf = await exampleSpec();
    lf.formula.text = 'Amount *\nRate';
    lf.formula.lineEndings = 'preserve';
    const crlf = clone(lf);
    crlf.formula.text = 'Amount *\r\nRate';
    assert.notEqual(buildDesiredState(lf).sourceSha256, buildDesiredState(crlf).sourceSha256);
  });

  it('keeps whitespace and Unicode normalization differences visible', async () => {
    const base = await exampleSpec();
    const spaced = clone(base);
    spaced.formula.text = 'Amount  * Rate';
    assert.notEqual(buildDesiredState(base).sourceSha256, buildDesiredState(spaced).sourceSha256);

    const nfc = clone(base);
    nfc.formula.text = 'Text("caf\u00e9")';
    const nfd = clone(base);
    nfd.formula.text = 'Text("cafe\u0301")';
    assert.notEqual(buildDesiredState(nfc).sourceSha256, buildDesiredState(nfd).sourceSha256);
  });

  it('treats tableReferences as a set but parameters as ordered', async () => {
    const a = await exampleSpec();
    a.tableReferences = [{ logicalName: 'b_table' }, { logicalName: 'a_table' }];
    const b = clone(a);
    b.tableReferences.reverse();
    assert.equal(buildDesiredState(a).specSha256, buildDesiredState(b).specSha256);

    const c = clone(a);
    c.parameters.reverse();
    assert.notEqual(buildDesiredState(a).specSha256, buildDesiredState(c).specSha256);
  });
});
