import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Auth, POWER_APPS_CLIENT_ID, POWER_APPS_RESOURCE, SignInRequiredError } from '../src/studio/auth.js';
import { normalizeEnvironmentUrl } from '../src/studio/dataverse.js';
import { checkFormula } from '../src/studio/fxCheck.js';
import { checkSpecText, deploy, findEnvironment, solutionPortalUrl } from '../src/studio/deploy.js';
import { packSolution } from '../src/studio/pack.js';
import { fileProfileStore, memoryProfileStore, parseStoredProfiles, type Protector } from '../src/studio/profileStore.js';
import { buildSolutionFiles, defaultStepId, deterministicGuid } from '../src/studio/solution.js';
import { parsePluginSpec, type PluginSpec } from '../src/studio/spec.js';
import {
  cli,
  clone,
  DEV_ID,
  ENV_URL,
  examplePath,
  fakeAuth,
  fakeBrowser,
  fakeDataverse,
  fakePlatform,
  MESSAGE_ID,
  OBJECT_ID,
  PROD_URL,
  SOLUTION_ID,
  tempDir,
  TENANT_ID,
  unzip,
} from './helpers.js';

const readSpec = async (name: string): Promise<PluginSpec> => JSON.parse(await readFile(examplePath(name), 'utf8')) as PluginSpec;
const withFormula = (spec: PluginSpec, formula: string): PluginSpec => ({ ...clone(spec), formula });
const codes = (spec: PluginSpec): string[] => checkFormula(spec).issues.map((i) => i.code);

describe('plug-in spec', () => {
  it('accepts both examples', async () => {
    for (const name of ['instant.plugin.json', 'automated.plugin.json']) {
      const parsed = parsePluginSpec(await readFile(examplePath(name), 'utf8'));
      assert.deepEqual(parsed.issues, [], name);
      assert.ok(parsed.spec);
    }
  });

  it('enforces kind-specific fields, prefixes, and unique parameter names', async () => {
    const instant = await readSpec('instant.plugin.json');
    const automated = await readSpec('automated.plugin.json');
    const cases: [unknown, string][] = [
      [{ ...clone(instant), uniqueName: 'other_CalculateFee' }, 'UNIQUE_NAME_INVALID'],
      [{ ...clone(instant), trigger: automated.trigger }, 'TRIGGER_NOT_ALLOWED'],
      [{ ...clone(automated), trigger: undefined }, 'TRIGGER_REQUIRED'],
      [{ ...clone(automated), parameters: instant.parameters }, 'PARAMETERS_NOT_ALLOWED'],
      [{ ...clone(instant), parameters: [...instant.parameters!, { name: 'amount', direction: 'input', type: 'String' }] }, 'PARAMETER_DUPLICATE'],
      [{ ...clone(instant), solution: { ...instant.solution, publisher: { ...instant.solution.publisher, prefix: 'msdyn' } }, uniqueName: 'msdyn_X' }, 'PREFIX_RESERVED'],
      [{ ...clone(instant), extra: true }, 'SCHEMA_UNKNOWN_PROPERTY'],
    ];
    for (const [spec, code] of cases) {
      const parsed = parsePluginSpec(JSON.stringify(spec));
      assert.equal(parsed.spec, undefined, code);
      assert.ok(parsed.issues.some((i) => i.code === code), `${code}: ${JSON.stringify(parsed.issues)}`);
    }
  });
});

describe('formula syntax check', () => {
  it('passes well-formed formulas, comments, quoted names, and interpolation', async () => {
    const spec = await readSpec('instant.plugin.json');
    const formula = '// fee\n/* block */ { Fee: With({ r: Rate }, Amount * r) + Value($"{Amount}{{x}}") + If(\'Amount\' > 0, 1, 0) }';
    assert.deepEqual(codes(withFormula(spec, formula)), []);
  });

  it('reports structural errors with line and column', async () => {
    const spec = await readSpec('instant.plugin.json');
    const unclosed = checkFormula(withFormula(spec, '{ Fee: Amount *\n  (Rate + 1 }')).issues[0]!;
    assert.equal(unclosed.code, 'FX_MISMATCHED_BRACKET');
    assert.equal(unclosed.line, 2);
    assert.equal(unclosed.column, 13);
    assert.ok(codes(withFormula(spec, '{ Fee: "abc }')).includes('FX_UNTERMINATED_STRING'));
    assert.ok(codes(withFormula(spec, '{ Fee: Amount * }')).includes('FX_OPERATOR_SEQUENCE') || codes(withFormula(spec, '{ Fee: Amount * }')).length > 0);
    assert.ok(codes(withFormula(spec, '{ Fee: Amount + Rate } +')).includes('FX_INCOMPLETE'));
    assert.ok(codes(withFormula(spec, '{ Fee: Max(Amount, Rate,) }')).includes('FX_TRAILING_COMMA'));
    assert.ok(codes(withFormula(spec, '// only a comment')).includes('FX_EMPTY'));
    assert.ok(codes(withFormula(spec, '{ Fee: Amount # Rate }')).includes('FX_UNEXPECTED_CHARACTER'));
  });

  it('warns about unused inputs, unassigned outputs, and unsupported functions', async () => {
    const spec = await readSpec('instant.plugin.json');
    const found = codes(withFormula(spec, 'Set(x, Amount)'));
    assert.ok(found.includes('FX_UNSUPPORTED_FUNCTION'));
    assert.ok(found.includes('FX_INPUT_UNUSED'));
    assert.ok(found.includes('FX_OUTPUT_UNASSIGNED'));
    const checked = checkSpecText(JSON.stringify(withFormula(spec, 'Set(x, Amount)')));
    assert.equal(checked.ok, true, 'warnings never block');
  });
});

describe('solution builder', () => {
  it('builds an instant plug-in as fxexpression + custom API with typed parameters', async () => {
    const files = buildSolutionFiles(await readSpec('instant.plugin.json'));
    assert.deepEqual([...files.keys()].sort(), [
      'Other/Customizations.xml',
      'Other/Solution.xml',
      'customapis/sample_CalculateFee/customapi.xml',
      'customapis/sample_CalculateFee/customapirequestparameters/Amount/customapirequestparameter.xml',
      'customapis/sample_CalculateFee/customapirequestparameters/Rate/customapirequestparameter.xml',
      'customapis/sample_CalculateFee/customapiresponseproperties/Fee/customapiresponseproperty.xml',
      'fxexpressions/sample_CalculateFee/expression.yaml',
      'fxexpressions/sample_CalculateFee/fxexpression.json',
    ]);
    const fx = JSON.parse(files.get('fxexpressions/sample_CalculateFee/fxexpression.json')!) as { fxexpression: Record<string, string> };
    assert.deepEqual(JSON.parse(fx.fxexpression['parameters']!), {
      InputParameter: [
        { isOptional: 0, name: 'Amount', type: 2 },
        { isOptional: 0, name: 'Rate', type: 2 },
      ],
      OutputParameter: [{ name: 'Fee', type: 2 }],
    });
    assert.match(files.get('customapis/sample_CalculateFee/customapi.xml')!, /<plugintypeexportkey>462b3e8f-beb4-4981-9b87-a60c2162a9f7<\/plugintypeexportkey>/);
    assert.equal(files.get('fxexpressions/sample_CalculateFee/expression.yaml'), '{ Fee: Amount * Rate }');
  });

  it('builds an automated plug-in as fxexpression + step with a stable id and stage', async () => {
    const spec = await readSpec('automated.plugin.json');
    const stepId = defaultStepId(spec);
    assert.equal(stepId, defaultStepId(clone(spec)));
    assert.match(stepId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const post = { ...clone(spec), trigger: { ...spec.trigger!, stage: 'postOperation' as const } };
    const files = buildSolutionFiles(post, { sdkMessageId: '9ebdbb1b-ea3e-db11-86a7-000a3a5473e8', stepId });
    const step = files.get(`SdkMessageProcessingSteps/{${stepId}}.xml`)!;
    assert.match(step, /<Stage>40<\/Stage>/);
    assert.match(step, /<PrimaryEntity>account<\/PrimaryEntity>/);
    assert.match(files.get('Other/Solution.xml')!, new RegExp(`<RootComponent type="92" id="\\{${stepId}\\}"`));
    const fx = JSON.parse(files.get('fxexpressions/sample_AccountNameRequired/fxexpression.json')!) as { fxexpression: Record<string, string> };
    assert.equal(fx.fxexpression['messagename'], 'Create');
    assert.equal(fx.fxexpression['entitylogicalname'], 'account');
    assert.equal(fx.fxexpression['parameters'], undefined);
    assert.throws(() => buildSolutionFiles(spec));
  });

  it('escapes XML in names and derives GUIDs deterministically', async () => {
    const spec = { ...(await readSpec('instant.plugin.json')), displayName: 'Fee <&> "x"' };
    assert.match(buildSolutionFiles(spec).get('customapis/sample_CalculateFee/customapi.xml')!, /Fee &lt;&amp;&gt; &quot;x&quot;/);
    assert.equal(deterministicGuid('a'), deterministicGuid('a'));
    assert.notEqual(deterministicGuid('a'), deterministicGuid('b'));
  });
});

describe('sign-in (Power Apps public client, fake Entra)', () => {
  it('signs in like the Power Apps CLI and remembers the account as the active profile', async () => {
    const { fetch, calls } = fakePlatform();
    const browser = fakeBrowser();
    const store = memoryProfileStore();
    const auth = fakeAuth(fetch, browser.openUrl, store);
    assert.equal((await auth.status()).state, 'signed-out');
    await assert.rejects(auth.getToken('https://contoso-dev.crm.dynamics.com'), SignInRequiredError);

    const authorizeUrl = await auth.startLogin();
    assert.equal((await auth.status()).state, 'pending');
    assert.equal(await auth.startLogin(), authorizeUrl, 'a running sign-in is reused');
    const profile = await auth.waitForLogin();
    assert.equal(profile.username, 'maker@contoso.com');
    assert.equal(profile.id, `${OBJECT_ID}.${TENANT_ID}`);
    const status = await auth.status();
    assert.equal(status.state, 'signed-in');
    assert.equal(status.active?.id, profile.id);
    assert.ok(!JSON.stringify(status).includes('refresh-'), 'refresh tokens never leave the store');
    assert.equal(store.data.activeId, profile.id);
    assert.equal(store.data.profiles[0]!.refreshToken, 'refresh-1');

    const url = new URL(authorizeUrl);
    assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
    assert.equal(url.searchParams.get('client_id'), POWER_APPS_CLIENT_ID);
    assert.equal(url.searchParams.get('scope'), 'https://service.powerapps.com//.default offline_access openid profile');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('redirect_uri')!, /^http:\/\/localhost:\d+$/);
    const redeem = new URLSearchParams(calls[0]!.body);
    assert.equal(redeem.get('code'), 'auth-code');
    assert.equal(createHash('sha256').update(redeem.get('code_verifier')!).digest('base64url'), url.searchParams.get('code_challenge'));

    assert.equal(await auth.getToken(POWER_APPS_RESOURCE), 'token-for-https://service.powerapps.com/');
    assert.equal(calls.length, 1, 'the sign-in token is cached for Power Platform');
    assert.equal(await auth.getToken('https://contoso-dev.crm.dynamics.com'), 'token-for-https://contoso-dev.crm.dynamics.com');
    const refresh = new URLSearchParams(calls[1]!.body);
    assert.equal(refresh.get('grant_type'), 'refresh_token');
    assert.equal(refresh.get('scope'), 'https://contoso-dev.crm.dynamics.com/.default offline_access');
    assert.ok(calls[1]!.url.includes(`/${TENANT_ID}/oauth2/v2.0/token`), 'refreshes against the signed-in tenant');
    assert.equal(store.data.profiles[0]!.refreshToken, 'refresh-2', 'rotated refresh tokens are saved');
    for (const bad of ['https://evil.example.com', 'https://contoso-dev.crm.dynamics.com/', 'https://login.microsoftonline.com']) {
      await assert.rejects(auth.getToken(bad), /only issued/, bad);
    }
  });

  it('keeps several profiles, switches between them, flags expired sign-ins and reconnects', async () => {
    const platform = fakePlatform();
    const store = memoryProfileStore();
    const auth = fakeAuth(platform.fetch, fakeBrowser().openUrl, store);
    await auth.startLogin();
    const first = await auth.waitForLogin();
    platform.options.user = { oid: '22222222-1234-4234-8234-123456789012', username: 'second@contoso.com' };
    const select = await auth.startLogin({ selectAccount: true });
    assert.equal(new URL(select).searchParams.get('prompt'), 'select_account');
    const second = await auth.waitForLogin();
    let status = await auth.status();
    assert.deepEqual(status.profiles.map((p) => p.username), ['second@contoso.com', 'maker@contoso.com'], 'most recent first');
    assert.equal(status.active?.id, second.id);

    await auth.useProfile(first.id);
    assert.equal((await auth.status()).active?.username, 'maker@contoso.com');

    platform.options.tokenError = { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.\nTrace ID: x' };
    await assert.rejects(auth.getToken('https://contoso-dev.crm.dynamics.com'), /maker@contoso\.com has expired; reconnect/);
    assert.equal((await auth.status()).active?.needsReauth, true);
    delete platform.options.tokenError;
    platform.options.user = { oid: OBJECT_ID, username: 'maker@contoso.com' };
    const reconnect = await auth.startLogin({ reconnect: true });
    assert.equal(new URL(reconnect).searchParams.get('login_hint'), 'maker@contoso.com');
    await auth.waitForLogin();
    status = await auth.status();
    assert.equal(status.active?.needsReauth, false);
    assert.equal(status.profiles.length, 2);

    await auth.removeProfile(first.id);
    status = await auth.status();
    assert.equal(status.active?.username, 'second@contoso.com', 'the next most recent profile becomes active');
    await auth.removeProfile(second.id);
    assert.equal((await auth.status()).state, 'signed-out');
    assert.deepEqual(store.data, { activeId: undefined, profiles: [] });
  });

  it('ignores redirects with the wrong state and reports sign-in errors without trace ids', async () => {
    const { fetch } = fakePlatform();
    const wrongState = fakeAuth(fetch, fakeBrowser({ state: 'forged' }).openUrl);
    await wrongState.startLogin();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await wrongState.status()).state, 'pending');
    wrongState.cancelLogin();
    assert.equal((await wrongState.status()).state, 'signed-out');
    assert.equal((await wrongState.status()).error, undefined, 'cancelling is not an error');

    const denied = fakeAuth(fetch, fakeBrowser({ error: 'access_denied' }).openUrl);
    await denied.startLogin();
    await assert.rejects(denied.waitForLogin(), /access_denied: AADSTS65001/);
    const deniedStatus = await denied.status();
    assert.equal(deniedStatus.state, 'signed-out');
    assert.doesNotMatch(deniedStatus.error!, /Trace ID/);
  });
});

describe('profile store', () => {
  it('persists profiles through a protector and ignores unreadable or malformed files', async () => {
    const dir = await tempDir();
    const path = join(dir, 'profiles.dat');
    const flip: Protector = { protect: async (d) => Buffer.from(d.map((b) => b ^ 0xff)), unprotect: async (d) => Buffer.from(d.map((b) => b ^ 0xff)) };
    const store = fileProfileStore(path, flip);
    assert.deepEqual(await store.load(), { activeId: undefined, profiles: [] });
    const data = { activeId: 'a.b', profiles: [{ id: 'a.b', username: 'u@x.com', name: 'U', tenantId: 't', lastUsed: '2026-01-01T00:00:00.000Z', refreshToken: 'secret-rt' }] };
    await store.save(data);
    assert.ok(!(await readFile(path)).includes('secret-rt'), 'the file is not plain text');
    assert.deepEqual(await store.load(), data);
    assert.deepEqual(await fileProfileStore(path, { protect: flip.protect, unprotect: () => Promise.reject(new Error('wrong user')) }).load(), {
      activeId: undefined,
      profiles: [],
    });
    assert.deepEqual(parseStoredProfiles('{"version":1,"activeId":"x","profiles":[{"id":"x"}]}'), { activeId: undefined, profiles: [] });
  });
});

describe('solution packer', () => {
  it('packs the SolutionPackager layout: BOM + CRLF root XML, inlined steps, unchanged components', async () => {
    const stepId = 'abcdefab-1234-4abc-8abc-abcdefabcdef';
    const files = buildSolutionFiles(await readSpec('automated.plugin.json'), { sdkMessageId: MESSAGE_ID, stepId });
    const entries = unzip(packSolution(files));
    assert.deepEqual([...entries.keys()], [
      'customizations.xml',
      'solution.xml',
      'fxexpressions/sample_AccountNameRequired/expression.yaml',
      'fxexpressions/sample_AccountNameRequired/fxexpression.json',
      '[Content_Types].xml',
    ]);
    const customizations = entries.get('customizations.xml')!.toString('utf8');
    assert.ok(customizations.startsWith('\uFEFF<?xml'));
    assert.ok(!/[^\r]\n/.test(customizations) && !customizations.endsWith('\n'), 'CRLF, no trailing newline');
    assert.match(customizations, new RegExp(`<SdkMessageProcessingSteps>\\r\\n    <SdkMessageProcessingStep Name="Account name required" SdkMessageProcessingStepId="\\{${stepId}\\}">`));
    assert.doesNotMatch(customizations, /<\?xml[\s\S]*<\?xml/);
    assert.equal(entries.get('solution.xml')!.toString('utf8'), `\uFEFF${files.get('Other/Solution.xml')!.trimEnd().replace(/\n/g, '\r\n')}`);
    assert.equal(entries.get('fxexpressions/sample_AccountNameRequired/expression.yaml')!.toString('utf8'), files.get('fxexpressions/sample_AccountNameRequired/expression.yaml'));
    assert.match(entries.get('[Content_Types].xml')!.toString('utf8'), /<Default Extension="xml" [^>]*\/><Default Extension="yaml" [^>]*\/><Default Extension="json" [^>]*\/>/);
    assert.ok(packSolution(files).equals(packSolution(files)), 'deterministic');
  });

  it('packs instant plug-ins with custom API folders and an empty steps element', async () => {
    const entries = unzip(packSolution(buildSolutionFiles(await readSpec('instant.plugin.json'))));
    assert.ok(entries.has('customapis/sample_CalculateFee/customapirequestparameters/Amount/customapirequestparameter.xml'));
    assert.match(entries.get('customizations.xml')!.toString('utf8'), /<SdkMessageProcessingSteps \/>/);
  });
});

describe('Dataverse client (fake transport)', () => {
  it('lists Dataverse environments with their type from the Power Platform API', async () => {
    const { fetch, calls } = fakePlatform();
    const environments = await fakeDataverse(fetch).environments();
    assert.deepEqual(environments, [
      { name: 'Contoso (default)', id: `Default-${TENANT_ID}`, url: 'https://orgdefault.crm.dynamics.com/', type: 'Default' },
      { name: 'Contoso Dev', id: DEV_ID, url: ENV_URL, type: 'Sandbox' },
      { name: 'Contoso Prod', id: '66666666-7777-8888-9999-000000000000', url: PROD_URL, type: 'Production' },
    ]);
    assert.equal(calls[0]!.url, 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments?api-version=2020-10-01');
    assert.equal(calls[0]!.authorization, 'Bearer token-for-https://service.powerapps.com/');
  });

  it('only accepts Dataverse https environment URLs', () => {
    assert.equal(normalizeEnvironmentUrl('https://Org.crm.dynamics.com'), 'https://org.crm.dynamics.com/');
    for (const bad of ['http://org.crm.dynamics.com', 'https://evil.com/', 'https://org.crm.dynamics.com.evil.com/', 'https://org.crm.dynamics.com/?x', 'https://org.crm.dynamics.com/ --x']) {
      assert.equal(normalizeEnvironmentUrl(bad), undefined, bad);
    }
  });

  it('links to the solution in the maker portal for commercial environments only', () => {
    const env = { name: 'x', id: DEV_ID, url: ENV_URL, type: 'Sandbox' as const };
    assert.equal(solutionPortalUrl(env, SOLUTION_ID), `https://make.powerapps.com/environments/${DEV_ID}/solutions/${SOLUTION_ID}`);
    assert.equal(solutionPortalUrl({ ...env, id: `Default-${TENANT_ID}` }, SOLUTION_ID), `https://make.powerapps.com/environments/Default-${TENANT_ID}/solutions/${SOLUTION_ID}`);
    assert.equal(solutionPortalUrl({ ...env, url: 'https://gov.crm9.dynamics.com/' }, SOLUTION_ID), undefined);
    assert.equal(solutionPortalUrl({ ...env, id: '' }, SOLUTION_ID), undefined);
  });
});

describe('deploy (fake Dataverse)', () => {
  const instant = () => readFile(examplePath('instant.plugin.json'), 'utf8');
  const automated = () => readFile(examplePath('automated.plugin.json'), 'utf8');

  it('checks, packs and imports an instant plug-in into a listed sandbox, then links the solution', async () => {
    const { fetch, calls } = fakePlatform();
    const progress: string[] = [];
    const result = await deploy({
      specText: await instant(),
      environment: ENV_URL,
      dataverse: fakeDataverse(fetch),
      onProgress: (steps) => progress.push(steps.map((s) => `${s.step}:${s.status}`).join(',')),
    });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.deepEqual(result.steps.map((s) => s.step), ['check', 'environment', 'pack', 'import']);
    assert.ok(progress.includes('check:done,environment:done,pack:done,import:running'), progress.join('\n'));
    assert.equal(result.solutionUrl, `https://make.powerapps.com/environments/${DEV_ID}/solutions/${SOLUTION_ID}`);
    const importCall = calls.find((c) => c.url.endsWith('/ImportSolutionAsync'))!;
    assert.equal(importCall.url, `${ENV_URL}api/data/v9.2/ImportSolutionAsync`);
    assert.equal(importCall.authorization, 'Bearer token-for-https://contoso-dev.crm.dynamics.com');
    const body = JSON.parse(importCall.body) as Record<string, unknown>;
    const entries = unzip(Buffer.from(body['CustomizationFile'] as string, 'base64'));
    assert.ok(entries.has('solution.xml') && entries.has('customapis/sample_CalculateFee/customapi.xml'));
    assert.equal(body['PublishWorkflows'], false);
    assert.equal(body['OverwriteUnmanagedCustomizations'], false);
  });

  it('resolves the message and reuses an existing step for automated plug-ins via the Web API', async () => {
    const existing = 'abcdefab-1234-4abc-8abc-abcdefabcdef';
    const dir = await tempDir();
    const { fetch, calls } = fakePlatform({ steps: [existing] });
    const result = await deploy({ specText: await automated(), environment: ENV_URL, dataverse: fakeDataverse(fetch), outDir: dir });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    const step = await readFile(join(dir, 'solution', 'SdkMessageProcessingSteps', `{${existing}}.xml`), 'utf8');
    assert.match(step, new RegExp(`<SdkMessageId>${MESSAGE_ID}</SdkMessageId>`));
    const zip = unzip(await readFile(join(dir, 'SampleLowCodePlugins.zip')));
    assert.match(zip.get('customizations.xml')!.toString('utf8'), new RegExp(`SdkMessageProcessingStepId="\\{${existing}\\}"`));
    const query = decodeURIComponent(new URL(calls.find((c) => c.url.includes('/sdkmessageprocessingsteps?'))!.url).searchParams.get('fetchXml')!);
    assert.match(query, /<condition attribute="uniquename" operator="eq" value="sample_AccountNameRequired" \/>/);
  });

  it('fails closed on ambiguous existing steps or messages', async () => {
    for (const options of [{ steps: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] }, { messages: [] }]) {
      const { fetch, calls } = fakePlatform(options);
      const result = await deploy({ specText: await automated(), environment: ENV_URL, dataverse: fakeDataverse(fetch) });
      assert.equal(result.status, 'failed');
      assert.equal(result.steps.at(-1)!.step, 'resolve');
      assert.ok(!calls.some((c) => c.method === 'POST'));
    }
  });

  it('deploys to production environments and reports their type', async () => {
    const result = await deploy({ specText: await instant(), environment: PROD_URL, dataverse: fakeDataverse(fakePlatform().fetch) });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(result.environment?.type, 'Production');
  });

  it('finds environments by URL, id or display name, and refuses ambiguous names', async () => {
    const environments = await fakeDataverse(fakePlatform().fetch).environments();
    for (const value of [ENV_URL, 'https://Contoso-Dev.crm.dynamics.com', DEV_ID, 'contoso dev']) {
      assert.equal((findEnvironment(environments, value) as { url: string }).url, ENV_URL, value);
    }
    assert.equal((findEnvironment(environments, `default-${TENANT_ID}`) as { type: string }).type, 'Default');
    assert.equal(findEnvironment(environments, 'Contoso'), 'none');
    assert.equal(findEnvironment(environments, ' '), 'none');
    const twins = [environments[1]!, { ...environments[1]!, url: 'https://twin.crm.dynamics.com/', id: 'x' }];
    assert.equal(findEnvironment(twins, 'Contoso Dev'), 'ambiguous');
  });

  it('blocks unlisted environments, signed-out users and specs that fail the check without importing', async () => {
    const spec = await instant();
    for (const [url, specText, tokens] of [
      ['https://other.crm.dynamics.com/', spec, undefined],
      ['https://evil.example.com/', spec, undefined],
      [ENV_URL, spec.replace('{ Fee: Amount * Rate }', '{ Fee: (Amount * Rate }'), undefined],
      [ENV_URL, spec, { getToken: () => Promise.reject(new SignInRequiredError()) }],
    ] as const) {
      const { fetch, calls } = fakePlatform();
      const result = await deploy({ specText, environment: url, dataverse: fakeDataverse(fetch, tokens) });
      assert.equal(result.status, 'blocked', url);
      assert.ok(!calls.some((c) => c.method === 'POST'), url);
    }
  });

  it('reports import failures from Dataverse', async () => {
    const { fetch } = fakePlatform({ importStatus: 31, importMessage: 'Publisher prefix mismatch.' });
    const importFailed = await deploy({ specText: await instant(), environment: ENV_URL, dataverse: fakeDataverse(fetch) });
    assert.equal(importFailed.status, 'failed');
    assert.equal(importFailed.steps.at(-1)!.detail, 'Publisher prefix mismatch.');
    assert.equal(importFailed.solutionUrl, undefined);
  });

  it('retries the import while another customization is running, with a new import job each time', async () => {
    const { fetch, calls } = fakePlatform({ busyImports: 2 });
    const progress: string[] = [];
    const result = await deploy({ specText: await instant(), environment: ENV_URL, dataverse: fakeDataverse(fetch), onProgress: (steps) => progress.push(steps.at(-1)!.detail) });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    const imports = calls.filter((c) => c.url.endsWith('/ImportSolutionAsync'));
    assert.equal(imports.length, 3);
    assert.equal(new Set(imports.map((c) => (JSON.parse(c.body) as { ImportJobId: string }).ImportJobId)).size, 3);
    assert.ok(progress.some((p) => /Another customization .* Retrying in 0s \(attempt 3 of 3\)/.test(p)), progress.join('\n'));

    const stillBusy = await deploy({ specText: await instant(), environment: ENV_URL, dataverse: fakeDataverse(fakePlatform({ busyImports: 5 }).fetch) });
    assert.equal(stillBusy.status, 'failed');
    assert.match(stillBusy.steps.at(-1)!.detail, /another \[EntityCustomization\] running[\s\S]*Gave up after 3 attempts\./);
  });
});

describe('CLI (agent workflow)', () => {
  const json = <T>(run: { stdout: string }): T => JSON.parse(run.stdout) as T;

  it('new applies settings and loads the formula from a script file', async () => {
    const dir = await tempDir();
    const fx = join(dir, 'fee.fx');
    await writeFile(fx, '\uFEFF{ Total: Price * Qty }\r\n', 'utf8');
    const path = join(dir, 'fee.plugin.json');
    const created = await cli([
      'new', '--kind', 'instant', '--out', path, '--prefix', 'contoso', '--name', 'OrderTotal', '--display-name', 'Order total',
      '--solution', 'ContosoPlugins', '--publisher', 'Contoso', '--params', 'Price:input:Decimal, Qty:input:Integer, Total:output:Decimal',
      '--formula-file', fx, '--json',
    ]);
    assert.equal(created.code, 0, created.stdout);
    assert.deepEqual(json<{ written: boolean; check: { ok: boolean } }>(created).check.ok, true);
    const spec = JSON.parse(await readFile(path, 'utf8')) as PluginSpec;
    assert.equal(spec.uniqueName, 'contoso_OrderTotal');
    assert.equal(spec.solution.publisher.prefix, 'contoso');
    assert.equal(spec.formula, '{ Total: Price * Qty }');
    assert.deepEqual(spec.parameters?.map((p) => p.name), ['Price', 'Qty', 'Total']);
    assert.equal((await cli(['new', '--kind', 'instant', '--out', path])).code, 3, 'never overwrites');
  });

  it('set updates a spec in place, renames on prefix change, and reports check issues', async () => {
    const dir = await tempDir();
    const path = join(dir, 'rule.plugin.json');
    assert.equal((await cli(['new', '--kind', 'automated', '--out', path])).code, 0);
    const updated = await cli(['set', '--spec', path, '--prefix', 'contoso', '--trigger-table', 'contact', '--message', 'Update', '--stage', 'postOperation', '--tables', 'none', '--json']);
    assert.equal(updated.code, 0, updated.stdout);
    const spec = JSON.parse(await readFile(path, 'utf8')) as PluginSpec;
    assert.equal(spec.uniqueName, 'contoso_AccountNameRequired');
    assert.deepEqual(spec.trigger, { table: 'contact', message: 'Update', stage: 'postOperation' });
    assert.deepEqual(spec.tables, []);

    const fx = join(dir, 'bad.fx');
    await writeFile(fx, 'If(IsBlank(NewRecord.name), Error("x"', 'utf8');
    const broken = await cli(['set', '--spec', path, '--formula-file', fx, '--json']);
    assert.equal(broken.code, 0, 'the spec is still written');
    assert.equal(json<{ check: { ok: boolean } }>(broken).check.ok, false);
    const checked = await cli(['check', '--spec', path, '--json']);
    assert.equal(checked.code, 3);
    assert.ok(json<{ issues: { code: string; line?: number }[] }>(checked).issues.some((i) => i.line === 1));
  });

  it('rejects settings that do not fit, and returns errors as JSON', async () => {
    const dir = await tempDir();
    const path = join(dir, 'fee.plugin.json');
    assert.equal((await cli(['new', '--kind', 'instant', '--out', path])).code, 0);
    const before = await readFile(path, 'utf8');
    for (const args of [
      ['--trigger-table', 'account'],
      ['--params', 'Amount:in:Decimal'],
      ['--params', 'Amount:input:Money'],
      ['--option-value-prefix', 'abc'],
      ['--formula-file', join(dir, 'missing.fx')],
      [],
    ]) {
      const run = await cli(['set', '--spec', path, ...args, '--json']);
      assert.equal(run.code, 3, args.join(' '));
      assert.equal(typeof json<{ error: string }>(run).error, 'string');
    }
    assert.equal(await readFile(path, 'utf8'), before, 'failed sets leave the file untouched');
    await writeFile(join(dir, 'broken.json'), '{ "kind": ', 'utf8');
    assert.equal((await cli(['set', '--spec', join(dir, 'broken.json'), '--name', 'X'])).code, 3);
  });

  it('signs in once, remembers the profile, lists environments and deploys by environment name', async () => {
    const dir = await tempDir();
    const path = join(dir, 'fee.plugin.json');
    assert.equal((await cli(['new', '--kind', 'instant', '--out', path])).code, 0);
    const platform = fakePlatform();
    const browser = fakeBrowser();
    const store = memoryProfileStore();
    const auth = fakeAuth(platform.fetch, browser.openUrl, store);
    const io = { auth, dataverse: fakeDataverse(platform.fetch, auth) };
    const envs = await cli(['envs', '--json'], io);
    assert.equal(envs.code, 0, envs.stdout);
    const listed = json<{ active: { username: string }; profiles: unknown[]; environments: { name: string; type: string }[] }>(envs);
    assert.equal(listed.active.username, 'maker@contoso.com');
    assert.equal(listed.profiles.length, 1);
    assert.deepEqual(listed.environments.map((e) => `${e.name}:${e.type}`), ['Contoso (default):Default', 'Contoso Dev:Sandbox', 'Contoso Prod:Production']);

    // A new process with the same store reuses the remembered profile without opening the browser.
    const later = fakeAuth(platform.fetch, browser.openUrl, store);
    const laterIo = { auth: later, dataverse: fakeDataverse(platform.fetch, later) };
    const deployed = await cli(['deploy', '--spec', path, '--environment', 'Contoso Dev', '--json'], laterIo);
    assert.equal(deployed.code, 0, deployed.stdout);
    assert.equal(json<{ status: string }>(deployed).status, 'succeeded');
    assert.equal(browser.opened.length, 1, 'signed in only once');
    assert.ok(platform.calls.some((c) => c.url === `${ENV_URL}api/data/v9.2/ImportSolutionAsync`));
    assert.equal((await cli(['deploy', '--spec', path, '--environment', 'Nowhere'], laterIo)).code, 2);
    assert.equal((await cli(['envs', '--profile', 'nobody@contoso.com', '--json'], laterIo)).code, 3);
    assert.equal((await cli(['envs', '--profile', 'MAKER@contoso.com', '--json'], laterIo)).code, 0);
  });

  it('reconnects automatically when the remembered sign-in has expired', async () => {
    const platform = fakePlatform();
    const browser = fakeBrowser();
    const store = memoryProfileStore();
    const auth = fakeAuth(platform.fetch, browser.openUrl, store);
    assert.equal((await cli(['login', '--json'], { auth, dataverse: fakeDataverse(platform.fetch, auth) })).code, 0);
    let failures = 1;
    const flaky: typeof platform.fetch = async (url, init) =>
      url.includes('/oauth2/v2.0/token') && String(init.body).includes('grant_type=refresh_token') && failures-- > 0
        ? new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), { status: 400 })
        : platform.fetch(url, init);
    const later = new Auth({ store, fetch: flaky, openUrl: browser.openUrl });
    const run = await cli(['envs'], { auth: later, dataverse: fakeDataverse(platform.fetch, later) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /has expired; reconnect/);
    assert.equal(new URL(browser.opened.at(-1)!).searchParams.get('login_hint'), 'maker@contoso.com');
  });

  it('prints help and rejects unknown commands, arguments and missing options', async () => {
    assert.match((await cli(['--help'])).stdout, /--formula-file/);
    assert.match((await cli(['set', '--help'])).stdout, /--params/);
    assert.equal((await cli(['apply'])).code, 3);
    assert.equal((await cli(['deploy', '--spec', 'x.json'])).code, 3);
    assert.equal((await cli(['deploy', '--spec', 'x.json', '--environment', ENV_URL, '--force'])).code, 3);
    assert.equal((await cli(['new', '--kind', 'other', '--out', 'x.json'])).code, 3);
    assert.equal((await cli(['ui', '--port', '99999'])).code, 3);
  });
});
