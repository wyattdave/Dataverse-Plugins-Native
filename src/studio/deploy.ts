import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkFormula } from './fxCheck.js';
import { lastLines, normalizeEnvironmentUrl, pacError, PacClient, type PacEnvironment } from './pac.js';
import { buildSolutionFiles, defaultStepId, xmlEscape, type AutomatedBinding, type SolutionFiles } from './solution.js';
import { parsePluginSpec, type Issue, type PluginSpec } from './spec.js';

export interface CheckResult {
  ok: boolean;
  spec: PluginSpec | undefined;
  issues: Issue[];
}

/** Step 2: schema rules plus the offline formula syntax check. Errors block deploy; warnings do not. */
export function checkSpecText(text: string): CheckResult {
  const parsed = parsePluginSpec(text);
  if (parsed.spec === undefined) {
    return { ok: false, spec: undefined, issues: parsed.issues };
  }
  const issues = [...parsed.issues, ...checkFormula(parsed.spec).issues];
  return { ok: !issues.some((i) => i.severity === 'error'), spec: parsed.spec, issues };
}

export async function writeSolutionFolder(files: SolutionFiles, folder: string): Promise<void> {
  for (const [relative, content] of files) {
    const path = join(folder, ...relative.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
}

export type StepStatus = 'done' | 'failed' | 'blocked' | 'skipped';

export interface DeployStep {
  step: string;
  status: StepStatus;
  detail: string;
}

export interface DeployResult {
  status: 'succeeded' | 'failed' | 'blocked';
  environment: PacEnvironment | undefined;
  steps: DeployStep[];
  issues: Issue[];
}

export interface DeployOptions {
  specText: string;
  /** Environment URL, display name or id, as listed by `pac env list`. */
  environment: string;
  pac: PacClient;
  /** Keep the generated solution folder and zip here instead of a temp folder that is removed afterwards. */
  outDir?: string;
}

/** Exactly one listed environment must match the URL, id or (case-insensitive) display name. */
export function findEnvironment(environments: readonly PacEnvironment[], value: string): PacEnvironment | 'none' | 'ambiguous' {
  const url = normalizeEnvironmentUrl(value);
  const key = value.trim().toLowerCase();
  if (key.length === 0) {
    return 'none';
  }
  const matches = environments.filter((e) => (url !== undefined && e.url === url) || e.id === key || e.name.toLowerCase() === key);
  return matches.length === 1 ? matches[0]! : matches.length === 0 ? 'none' : 'ambiguous';
}

const fetchXml = (entity: string, attribute: string, filter: string, link = ''): string =>
  `<fetch top="5"><entity name="${entity}"><attribute name="${attribute}" />${filter}${link}</entity></fetch>`;

/** Looks up the SDK message id and any existing step for this expression so redeploys update in place. */
async function resolveBinding(spec: PluginSpec, environmentUrl: string, pac: PacClient, workDir: string): Promise<AutomatedBinding> {
  const trigger = spec.trigger!;
  const messageFile = join(workDir, 'message.fetch.xml');
  await writeFile(
    messageFile,
    fetchXml('sdkmessage', 'sdkmessageid', `<filter><condition attribute="name" operator="eq" value="${xmlEscape(trigger.message)}" /></filter>`),
    'utf8',
  );
  const messages = await pac.fetchGuids(environmentUrl, messageFile, 'sdkmessageid');
  if (messages === undefined || messages.length !== 1) {
    throw new Error(`Could not resolve a single SDK message id for "${trigger.message}".`);
  }
  const stepFile = join(workDir, 'step.fetch.xml');
  await writeFile(
    stepFile,
    fetchXml(
      'sdkmessageprocessingstep',
      'sdkmessageprocessingstepid',
      '',
      `<link-entity name="fxexpression" from="fxexpressionid" to="fxexpressionid"><filter><condition attribute="uniquename" operator="eq" value="${xmlEscape(spec.uniqueName)}" /></filter></link-entity>`,
    ),
    'utf8',
  );
  const steps = await pac.fetchGuids(environmentUrl, stepFile, 'sdkmessageprocessingstepid');
  if (steps === undefined || steps.length > 1) {
    throw new Error('More than one existing step is linked to this expression; fix it in the environment before redeploying.');
  }
  return { sdkMessageId: messages[0]!, stepId: steps[0] ?? defaultStepId(spec) };
}

/** Step 4: check → confirm environment → build solution → pac solution pack → pac solution import. */
export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const steps: DeployStep[] = [];
  const result = (status: DeployResult['status'], environment: PacEnvironment | undefined, issues: Issue[] = []): DeployResult => ({
    status,
    environment,
    steps,
    issues,
  });

  const checked = checkSpecText(options.specText);
  if (!checked.ok || checked.spec === undefined) {
    steps.push({ step: 'check', status: 'blocked', detail: 'Fix the errors reported by check first.' });
    return result('blocked', undefined, checked.issues);
  }
  const spec = checked.spec;
  steps.push({ step: 'check', status: 'done', detail: `${checked.issues.length} warning(s).` });

  const { environments, result: listResult } = await options.pac.environments();
  if (listResult.code !== 0) {
    steps.push({ step: 'environment', status: 'blocked', detail: `pac env list failed: ${pacError(listResult.output)}` });
    return result('blocked', undefined, checked.issues);
  }
  const environment = findEnvironment(environments, options.environment);
  if (typeof environment === 'string') {
    const detail =
      environment === 'ambiguous'
        ? 'More than one environment matches; use the environment URL.'
        : 'Environment is not available to the active pac profile (use a URL, name or id from envs).';
    steps.push({ step: 'environment', status: 'blocked', detail });
    return result('blocked', undefined, checked.issues);
  }
  const url = environment.url;
  steps.push({ step: 'environment', status: 'done', detail: `${environment.name || environment.url} (type: ${environment.type}).` });

  const workDir = options.outDir ?? (await mkdtemp(join(tmpdir(), 'dv-native-')));
  try {
    await mkdir(workDir, { recursive: true });
    let binding: AutomatedBinding | undefined;
    if (spec.kind === 'automated') {
      try {
        binding = await resolveBinding(spec, url, options.pac, workDir);
        steps.push({ step: 'resolve', status: 'done', detail: `Message ${spec.trigger!.message} → step ${binding.stepId}.` });
      } catch (error) {
        steps.push({ step: 'resolve', status: 'failed', detail: error instanceof Error ? error.message : 'Lookup failed.' });
        return result('failed', environment, checked.issues);
      }
    }

    const folder = join(workDir, 'solution');
    const zip = join(workDir, `${spec.solution.uniqueName}.zip`);
    await writeSolutionFolder(buildSolutionFiles(spec, binding), folder);
    const packed = await options.pac.pack(folder, zip);
    if (packed.code !== 0) {
      steps.push({ step: 'pack', status: 'failed', detail: lastLines(packed.output) });
      return result('failed', environment, checked.issues);
    }
    steps.push({ step: 'pack', status: 'done', detail: options.outDir === undefined ? 'Solution packed.' : zip });

    const imported = await options.pac.importSolution(url, zip);
    if (imported.code !== 0) {
      steps.push({ step: 'import', status: 'failed', detail: lastLines(imported.output) });
      return result('failed', environment, checked.issues);
    }
    steps.push({ step: 'import', status: 'done', detail: `Imported into ${spec.solution.uniqueName}.` });
    return result('succeeded', environment, checked.issues);
  } finally {
    if (options.outDir === undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
