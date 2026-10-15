import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TargetConfig } from '../../src/contracts/target.js';
import { DataverseReadTransport, type FetchLike, type TransportOptions } from '../../src/dataverse/readTransport.js';
import { resolveTarget } from '../../src/dataverse/targetResolver.js';
import { clone, exampleTarget } from '../helpers.js';
import { FakeClock, FakeFetch, FakeTokenProvider, fakeJwt, type FakeResponseSpec } from './fakes/fakeHttp.js';

const ORIGIN = 'https://example-sandbox.crm.dynamics.com';
const TENANT = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-000000000003';
const GOOD_TOKEN = fakeJwt({ aud: ORIGIN, tid: TENANT, exp: Date.parse('2026-10-15T11:00:00Z') / 1000 });
const WHO_AM_I: FakeResponseSpec = {
  status: 200,
  body: { UserId: '00000000-0000-4000-8000-0000000000b1', BusinessUnitId: '00000000-0000-4000-8000-0000000000b2', OrganizationId: ORG },
  headers: { 'x-ms-service-request-id': '00000000-0000-4000-8000-0000000000c1' },
};

async function setup(
  responses: (FakeResponseSpec | 'hang')[],
  token = GOOD_TOKEN,
  options: Partial<TransportOptions> = {},
  target?: TargetConfig,
): Promise<{ transport: DataverseReadTransport; fetch: FakeFetch; tokens: FakeTokenProvider; clock: FakeClock }> {
  const fetch = new FakeFetch(responses);
  const tokens = new FakeTokenProvider(token);
  const clock = new FakeClock();
  const transport = new DataverseReadTransport(target ?? (await exampleTarget()), tokens, fetch.fetch, options, clock);
  return { transport, fetch, tokens, clock };
}

const attributesPage = (n: number, next?: string): FakeResponseSpec => ({
  status: 200,
  body: { value: [{ LogicalName: `attr${n}`, AttributeType: 'String' }], ...(next !== undefined ? { '@odata.nextLink': next } : {}) },
});

describe('read transport trust boundary (T04)', () => {
  it('refuses to construct for a target outside the trust boundary', async () => {
    const target = clone(await exampleTarget());
    target.allowedOrigins = ['https://other.crm.dynamics.com'];
    assert.throws(() => new DataverseReadTransport(target, new FakeTokenProvider(GOOD_TOKEN), new FakeFetch([]).fetch));
    const selfAllowlisted = clone(await exampleTarget());
    selfAllowlisted.expectedTarget.organizationUrl = 'https://attacker.example.com';
    selfAllowlisted.allowedOrigins = ['https://attacker.example.com'];
    assert.throws(() => new DataverseReadTransport(selfAllowlisted, new FakeTokenProvider(GOOD_TOKEN), new FakeFetch([]).fetch));
  });

  it('requests a token scoped to the organization origin and sends only GET without following redirects', async () => {
    const { transport, fetch, tokens } = await setup([WHO_AM_I]);
    const result = await transport.whoAmI();
    assert.equal(result.ok, true);
    assert.deepEqual(tokens.requests[0]!.scopes, [`${ORIGIN}/user_impersonation`]);
    assert.equal(tokens.requests[0]!.authorityTenantId, TENANT);
    assert.equal(fetch.requests.length, 1);
    assert.equal(fetch.requests[0]!.init.method, 'GET');
    assert.equal(fetch.requests[0]!.init.redirect, 'manual');
    assert.ok(fetch.requests[0]!.url.startsWith(`${ORIGIN}/api/data/v9.2/`));
  });

  it('rejects tokens for the wrong audience or tenant before any request is sent', async () => {
    const wrongAud = await setup([WHO_AM_I], fakeJwt({ aud: 'https://evil.crm.dynamics.com', tid: TENANT }));
    assert.equal(((await wrongAud.transport.whoAmI()) as { reasonCode: string }).reasonCode, 'TOKEN_AUDIENCE_MISMATCH');
    assert.equal(wrongAud.fetch.requests.length, 0);

    const wrongTenant = await setup([WHO_AM_I], fakeJwt({ aud: `${ORIGIN}/`, tid: '00000000-0000-4000-8000-000000000099' }));
    assert.equal(((await wrongTenant.transport.whoAmI()) as { reasonCode: string }).reasonCode, 'TOKEN_TENANT_MISMATCH');
    assert.equal(wrongTenant.fetch.requests.length, 0);

    const opaque = await setup([WHO_AM_I], 'not-a-jwt');
    assert.equal(((await opaque.transport.whoAmI()) as { reasonCode: string }).reasonCode, 'TOKEN_UNVERIFIABLE');
    assert.equal(opaque.fetch.requests.length, 0);

    const expired = await setup([WHO_AM_I], fakeJwt({ aud: ORIGIN, tid: TENANT, exp: Date.parse('2026-10-15T09:00:00Z') / 1000 }));
    assert.equal(((await expired.transport.whoAmI()) as { reasonCode: string }).reasonCode, 'TOKEN_ACQUISITION_FAILED');
  });

  it('never follows redirects', async () => {
    const { transport, fetch } = await setup([{ status: 302, headers: { location: 'https://evil.example.com/steal' } }]);
    const result = await transport.whoAmI();
    assert.equal((result as { reasonCode: string }).reasonCode, 'TRANSPORT_REDIRECT_REJECTED');
    assert.equal(fetch.requests.length, 1);
    assert.equal(fetch.requests.some((r) => r.url.includes('evil')), false);
  });

  it('rejects untrusted nextLinks, keeps prior pages, and marks completeness partial', async () => {
    const select = '$select=LogicalName,AttributeType';
    for (const evil of [
      'https://evil.example.com/api/data/v9.2/next',
      'http://example-sandbox.crm.dynamics.com/api/data/v9.2/next',
      `${ORIGIN}/other/path`,
      `${ORIGIN}/api/data/v9.2/accounts?$select=name`,
      `${ORIGIN}/api/data/v9.2/EntityDefinitions(LogicalName='account')/Attributes?$select=*&$skiptoken=2`,
      `${ORIGIN}/api/data/v9.2/EntityDefinitions(LogicalName='account')/Attributes?${select}&$filter=x&$skiptoken=2`,
    ]) {
      const { transport, fetch } = await setup([attributesPage(1, evil)]);
      const result = await transport.listAttributes('account');
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.completeness, 'partial', evil);
        assert.deepEqual(result.gaps, ['TRANSPORT_NEXT_LINK_REJECTED']);
        assert.equal(result.value.length, 1);
      }
      assert.equal(fetch.requests.length, 1);
    }
  });

  it('follows trusted nextLinks and bounds the page count', async () => {
    const next = `${ORIGIN}/api/data/v9.2/EntityDefinitions(LogicalName='account')/Attributes?$select=LogicalName,AttributeType&$skiptoken=2`;
    const ok = await setup([attributesPage(1, next), attributesPage(2)]);
    const full = await ok.transport.listAttributes('account');
    assert.equal(full.ok && full.completeness, 'complete');
    assert.equal(full.ok && full.value.length, 2);

    const bounded = await setup([attributesPage(1, next), attributesPage(2, next)], GOOD_TOKEN, { maxPages: 2 });
    const limited = await bounded.transport.listAttributes('account');
    assert.equal(limited.ok && limited.completeness, 'partial');
    assert.deepEqual(limited.ok && limited.gaps, ['TRANSPORT_PAGE_LIMIT_REACHED']);
  });

  it('validates identifiers before building any request', async () => {
    const { transport, fetch } = await setup([]);
    const result = await transport.getEntitySetName("account')/../x");
    assert.equal((result as { reasonCode: string }).reasonCode, 'TRANSPORT_IDENTIFIER_INVALID');
    assert.equal(fetch.requests.length, 0);
  });

  it('verifies the organization identity from WhoAmI', async () => {
    const wrong = { ...WHO_AM_I, body: { ...(WHO_AM_I.body as object), OrganizationId: '00000000-0000-4000-8000-000000000099' } };
    const { transport } = await setup([wrong]);
    assert.equal(((await transport.whoAmI()) as { reasonCode: string }).reasonCode, 'TARGET_ORGANIZATION_MISMATCH');
  });

  it('resolves identity but leaves environment classification unknown', async () => {
    const { transport } = await setup([WHO_AM_I]);
    const resolved = await resolveTarget(transport, TENANT);
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.environmentClass, 'unknown');
      assert.equal(resolved.classificationReason, 'ENVIRONMENT_CLASSIFICATION_ROUTE_UNAVAILABLE');
      assert.match(resolved.principalFingerprint, /^[0-9a-f]{64}$/);
    }
  });
});

describe('read transport failure handling (T05)', () => {
  it('does not retry or escalate on 401/403', async () => {
    for (const [status, code] of [
      [401, 'TRANSPORT_UNAUTHENTICATED'],
      [403, 'TRANSPORT_FORBIDDEN'],
    ] as const) {
      const { transport, fetch, tokens } = await setup([{ status }, WHO_AM_I]);
      const result = await transport.whoAmI();
      assert.equal((result as { reasonCode: string }).reasonCode, code);
      assert.equal((result as { completeness: string }).completeness, 'unknown');
      assert.equal(fetch.requests.length, 1);
      assert.equal(tokens.requests.length, 1);
    }
  });

  it('retries throttling with the server-specified delay', async () => {
    const { transport, fetch, clock } = await setup([{ status: 429, headers: { 'retry-after': '2' } }, WHO_AM_I]);
    const result = await transport.whoAmI();
    assert.equal(result.ok, true);
    assert.equal(fetch.requests.length, 2);
    assert.deepEqual(clock.sleeps, [2000]);
  });

  it('caps retries and backs off exponentially without a Retry-After', async () => {
    const { transport, fetch, clock } = await setup([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
    const result = await transport.whoAmI();
    assert.equal((result as { reasonCode: string }).reasonCode, 'TRANSPORT_THROTTLED_EXHAUSTED');
    assert.equal(fetch.requests.length, 4);
    assert.deepEqual(clock.sleeps, [500, 1000, 2000]);
  });

  it('never retries earlier than the server asks and respects the total deadline', async () => {
    const tooLong = await setup([{ status: 429, headers: { 'retry-after': '120' } }]);
    assert.equal(((await tooLong.transport.whoAmI()) as { reasonCode: string }).reasonCode, 'TRANSPORT_THROTTLED_EXHAUSTED');
    assert.deepEqual(tooLong.clock.sleeps, []);

    const deadline = await setup([{ status: 429, headers: { 'retry-after': '8' } }], GOOD_TOKEN, { totalDeadlineMs: 5000 });
    assert.equal(((await deadline.transport.whoAmI()) as { reasonCode: string }).reasonCode, 'TRANSPORT_DEADLINE_EXCEEDED');
    assert.deepEqual(deadline.clock.sleeps, []);
  });

  it('times out hung requests', async () => {
    const { transport } = await setup(['hang'], GOOD_TOKEN, { requestTimeoutMs: 20 });
    assert.equal(((await transport.whoAmI()) as { reasonCode: string }).reasonCode, 'TRANSPORT_TIMEOUT');
  });

  it('never leaks platform error bodies into results', async () => {
    const { transport } = await setup([{ status: 500, body: { error: { message: 'SECRET_ERROR_BODY Bearer abc' } } }]);
    const result = await transport.whoAmI();
    assert.equal((result as { reasonCode: string }).reasonCode, 'TRANSPORT_HTTP_ERROR');
    assert.equal(JSON.stringify(result).includes('SECRET_ERROR_BODY'), false);
  });

  it('rejects oversized and malformed responses', async () => {
    const big = await setup([{ status: 200, body: 'x'.repeat(100) }], GOOD_TOKEN, { maxResponseBytes: 10 });
    assert.equal(((await big.transport.whoAmI()) as { reasonCode: string }).reasonCode, 'TRANSPORT_RESPONSE_TOO_LARGE');
    const malformed = await setup([{ status: 200, body: '{not json' }]);
    assert.equal(((await malformed.transport.whoAmI()) as { reasonCode: string }).reasonCode, 'TRANSPORT_RESPONSE_INVALID');
  });

  it('stops streaming and aborts as soon as the byte limit is exceeded', async () => {
    let chunksRead = 0;
    let aborted = false;
    const fetchImpl: FetchLike = async (_url, init) => {
      init.signal.addEventListener('abort', () => (aborted = true));
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => assert.fail('text() must not be used when a stream is available'),
        body: (async function* () {
          for (let i = 0; i < 1000; i++) {
            chunksRead++;
            yield new Uint8Array(1024);
          }
        })(),
      };
    };
    const transport = new DataverseReadTransport(await exampleTarget(), new FakeTokenProvider(GOOD_TOKEN), fetchImpl, { maxResponseBytes: 4096 }, new FakeClock());
    assert.equal(((await transport.whoAmI()) as { reasonCode: string }).reasonCode, 'TRANSPORT_RESPONSE_TOO_LARGE');
    assert.ok(chunksRead <= 5, `read ${chunksRead} chunks`);
    assert.equal(aborted, true);
  });
});
