import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkFormula } from '../src/studio/fxCheck.js';
import { checkSpecText, deploy, findEnvironment } from '../src/studio/deploy.js';
import { PacClient, normalizeEnvironmentUrl, parseAuthList, parseEnvList, parseFetchGuids, type PacRunner } from '../src/studio/pac.js';
import { buildSolutionFiles, defaultStepId, deterministicGuid } from '../src/studio/solution.js';
import { parsePluginSpec, type PluginSpec } from '../src/studio/spec.js';
import { cli, clone, examplePath, tempDir } from './helpers.js';

const readSpec = async (name: string): Promise<PluginSpec> => JSON.parse(await readFile(examplePath(name), 'utf8')) as PluginSpec;
const withFormula = (spec: PluginSpec, formula: string): PluginSpec => ({ ...clone(spec), formula });
const codes = (spec: PluginSpec): string[] => checkFormula(spec).issues.map((i) => i.code);

const ENV_URL = 'https://contoso-dev.crm.dynamics.com/';

/** Fake pac: canned output per command; records every call. No process is ever spawned. */
function fakePac(overrides: Partial<Record<string, { code: number; output: string }>> = {}): { runner: PacRunner; calls: string[][] } {
  const calls: string[][] = [];
  const defaults: Record<string, { code: number; output: string }> = {
    'auth list': {
      code: 0,
      output:
        'Index Active Kind      Name User              Cloud  Type Environment     Environment Url\n' +
        '[1]   *      UNIVERSAL      maker@contoso.com Public User Contoso Dev     https://contoso-dev.crm.dynamics.com/\n',
    },
    'env list': {
      code: 0,
      output:
        'Active Display Name    Environment ID                       Environment URL                        Unique Name    Type\n' +
        '*      Contoso Dev     11111111-2222-3333-4444-555555555555 https://contoso-dev.crm.dynamics.com/  unq1           Sandbox\n' +
        '       Contoso Prod    66666666-7777-8888-9999-000000000000 https://contoso.crm.dynamics.com/      unq2           Production\n',
    },
    'solution pack': { code: 0, output: 'Packing complete.' },
    'solution import': { code: 0, output: 'Solution Imported successfully.' },
    'fetch message': { code: 0, output: 'sdkmessageid\n9ebdbb1b-ea3e-db11-86a7-000a3a5473e8\n' },
    'fetch step': { code: 0, output: 'sdkmessageprocessingstepid\n' },
  };
  const runner: PacRunner = async (args) => {
    calls.push([...args]);
    let key = `${args[0]} ${args[1]}`;
    if (key === 'env fetch') {
      const xml = await readFile(args[args.indexOf('--xmlFile') + 1]!, 'utf8');
      key = xml.includes('sdkmessageprocessingstep') ? 'fetch step' : 'fetch message';
    }
    return overrides[key] ?? defaults[key] ?? { code: 1, output: `unexpected pac call: ${args.join(' ')}` };
  };
  return { runner, calls };
}

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

describe('pac output parsing', () => {
  it('parses auth profiles, environments, and fetch results', () => {
    const profiles = parseAuthList(
      'Index Active Kind      Name User             Cloud  Type            Environment              Environment Url\n' +
        '[1]   *      UNIVERSAL      maker@contoso.com Public OperatingSystem Team Tools    https://org1.crm.dynamics.com/\n' +
        '[2]          UNIVERSAL      maker@contoso.com Public User            Dev Env       https://contoso-dev.crm4.dynamics.com/\n',
    );
    assert.deepEqual(profiles, [
      { index: 1, active: true, user: 'maker@contoso.com', environment: 'Team Tools', environmentUrl: 'https://org1.crm.dynamics.com/' },
      { index: 2, active: false, user: 'maker@contoso.com', environment: 'Dev Env', environmentUrl: 'https://contoso-dev.crm4.dynamics.com/' },
    ]);
    const envs = parseEnvList(
      'Active Display Name    Environment ID                       Environment URL                        Unique Name\n' +
        '*      Contoso Dev     11111111-2222-3333-4444-555555555555 https://Contoso-Dev.crm.dynamics.com   unq1\n',
    );
    assert.deepEqual(envs, [{ name: 'Contoso Dev', id: '11111111-2222-3333-4444-555555555555', url: 'https://contoso-dev.crm.dynamics.com/', active: true, type: 'Unknown' }]);
    assert.deepEqual(parseFetchGuids('Connected to org 99999999-9999-9999-9999-999999999999\nsdkmessageid\n9EBDBB1B-EA3E-DB11-86A7-000A3A5473E8\n', 'sdkmessageid'), ['9ebdbb1b-ea3e-db11-86a7-000a3a5473e8']);
    assert.deepEqual(parseFetchGuids('No records.\n', 'sdkmessageid'), []);
    assert.equal(parseFetchGuids('id 99999999-9999-9999-9999-999999999999', 'sdkmessageid'), undefined);
  });

  it('only accepts Dataverse https environment URLs', () => {
    assert.equal(normalizeEnvironmentUrl('https://Org.crm.dynamics.com'), 'https://org.crm.dynamics.com/');
    for (const bad of ['http://org.crm.dynamics.com', 'https://evil.com/', 'https://org.crm.dynamics.com.evil.com/', 'https://org.crm.dynamics.com/?x', 'https://org.crm.dynamics.com/ --x']) {
      assert.equal(normalizeEnvironmentUrl(bad), undefined, bad);
    }
  });
});

describe('deploy (fake pac)', () => {
  it('checks, packs and imports an instant plug-in into a listed sandbox', async () => {
    const { runner, calls } = fakePac();
    const result = await deploy({ specText: await readFile(examplePath('instant.plugin.json'), 'utf8'), environment: ENV_URL, pac: new PacClient(runner) });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.deepEqual(result.steps.map((s) => s.step), ['check', 'environment', 'pack', 'import']);
    assert.deepEqual(calls.map((c) => `${c[0]} ${c[1]}`), ['env list', 'solution pack', 'solution import']);
    const importCall = calls.at(-1)!;
    assert.equal(importCall[importCall.indexOf('--environment') + 1], ENV_URL);
    assert.ok(!importCall.includes('--publish-changes') && !importCall.includes('--activate-plugins'));
  });

  it('resolves the message and reuses an existing step for automated plug-ins', async () => {
    const existing = 'abcdefab-1234-4abc-8abc-abcdefabcdef';
    const dir = await tempDir();
    const { runner } = fakePac({ 'fetch step': { code: 0, output: `sdkmessageprocessingstepid\n${existing}\n` } });
    const result = await deploy({ specText: await readFile(examplePath('automated.plugin.json'), 'utf8'), environment: ENV_URL, pac: new PacClient(runner), outDir: dir });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    const step = await readFile(join(dir, 'solution', 'SdkMessageProcessingSteps', `{${existing}}.xml`), 'utf8');
    assert.match(step, /<SdkMessageId>9ebdbb1b-ea3e-db11-86a7-000a3a5473e8<\/SdkMessageId>/);
  });

  it('fails closed on ambiguous existing steps', async () => {
    const { runner, calls } = fakePac({
      'fetch step': { code: 0, output: 'sdkmessageprocessingstepid\naaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nbbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\n' },
    });
    const result = await deploy({ specText: await readFile(examplePath('automated.plugin.json'), 'utf8'), environment: ENV_URL, pac: new PacClient(runner) });
    assert.equal(result.status, 'failed');
    assert.ok(!calls.some((c) => c[0] === 'solution'));
  });

  it('deploys to production environments listed by pac', async () => {
    const { runner, calls } = fakePac();
    const spec = await readFile(examplePath('instant.plugin.json'), 'utf8');
    const result = await deploy({ specText: spec, environment: 'https://contoso.crm.dynamics.com/', pac: new PacClient(runner) });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(result.environment?.type, 'Production');
    assert.ok(calls.some((c) => c[0] === 'solution' && c[1] === 'import'));
  });

  it('finds environments by URL, id or display name, and refuses ambiguous names', async () => {
    const { runner } = fakePac();
    const { environments } = await new PacClient(runner).environments();
    for (const value of [ENV_URL, 'https://Contoso-Dev.crm.dynamics.com', '11111111-2222-3333-4444-555555555555', 'contoso dev']) {
      assert.equal((findEnvironment(environments, value) as { url: string }).url, ENV_URL, value);
    }
    assert.equal(findEnvironment(environments, 'Contoso'), 'none');
    assert.equal(findEnvironment(environments, ' '), 'none');
    const twins = [environments[0]!, { ...environments[0]!, url: 'https://twin.crm.dynamics.com/', id: 'x' }];
    assert.equal(findEnvironment(twins, 'Contoso Dev'), 'ambiguous');
  });

  it('blocks unlisted environments and specs that fail the check without importing', async () => {
    const spec = await readFile(examplePath('instant.plugin.json'), 'utf8');
    for (const [url, specText] of [
      ['https://other.crm.dynamics.com/', spec],
      ['https://evil.example.com/', spec],
      [ENV_URL, spec.replace('{ Fee: Amount * Rate }', '{ Fee: (Amount * Rate }')],
    ] as const) {
      const { runner, calls } = fakePac();
      const result = await deploy({ specText, environment: url, pac: new PacClient(runner) });
      assert.equal(result.status, 'blocked', url);
      assert.ok(!calls.some((c) => c[0] === 'solution'), url);
    }
  });

  it('reports pack and import failures', async () => {
    const spec = await readFile(examplePath('instant.plugin.json'), 'utf8');
    const { runner } = fakePac({ 'solution import': { code: 1, output: 'Error: publisher mismatch' } });
    const result = await deploy({ specText: spec, environment: ENV_URL, pac: new PacClient(runner) });
    assert.equal(result.status, 'failed');
    assert.match(result.steps.at(-1)!.detail, /publisher mismatch/);
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

  it('lists environments and deploys by environment name through pac', async () => {
    const dir = await tempDir();
    const path = join(dir, 'fee.plugin.json');
    assert.equal((await cli(['new', '--kind', 'instant', '--out', path])).code, 0);
    const { runner, calls } = fakePac();
    const envs = await cli(['envs', '--json'], runner);
    assert.equal(envs.code, 0);
    assert.deepEqual(json<{ environments: { name: string }[] }>(envs).environments.map((e) => e.name), ['Contoso Dev', 'Contoso Prod']);
    const deployed = await cli(['deploy', '--spec', path, '--environment', 'Contoso Dev', '--json'], runner);
    assert.equal(deployed.code, 0, deployed.stdout);
    assert.equal(json<{ status: string }>(deployed).status, 'succeeded');
    const importCall = calls.find((c) => c[0] === 'solution' && c[1] === 'import')!;
    assert.equal(importCall[importCall.indexOf('--environment') + 1], ENV_URL);
    assert.equal((await cli(['deploy', '--spec', path, '--environment', 'Nowhere'], fakePac().runner)).code, 2);
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
