import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeEnvironmentUrl, type DataverseClient, type Environment } from './dataverse.js';
import { checkFormula } from './fxCheck.js';
import { packSolution } from './pack.js';
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

export type StepStatus = 'running' | 'done' | 'failed' | 'blocked' | 'skipped';

export interface DeployStep {
  step: string;
  status: StepStatus;
  detail: string;
}

export interface DeployResult {
  status: 'succeeded' | 'failed' | 'blocked';
  environment: Environment | undefined;
  steps: DeployStep[];
  issues: Issue[];
  /** Power Apps maker portal link to the solution, when it could be resolved after import. */
  solutionUrl?: string;
}

export interface DeployOptions {
  specText: string;
  /** Environment URL, display name or id, as listed by `envs`. */
  environment: string;
  dataverse: DataverseClient;
  /** Also write the unpacked solution folder and the zip here, for inspection. */
  outDir?: string;
  /** Called with a snapshot of the steps whenever one starts, changes or ends. */
  onProgress?: (steps: DeployStep[]) => void;
}

/** Exactly one listed environment must match the URL, id or (case-insensitive) display name. */
export function findEnvironment(environments: readonly Environment[], value: string): Environment | 'none' | 'ambiguous' {
  const url = normalizeEnvironmentUrl(value);
  const key = value.trim().toLowerCase();
  if (key.length === 0) {
    return 'none';
  }
  const matches = environments.filter((e) => (url !== undefined && e.url === url) || e.id.toLowerCase() === key || e.name.toLowerCase() === key);
  return matches.length === 1 ? matches[0]! : matches.length === 0 ? 'none' : 'ambiguous';
}

const fetchXml = (entity: string, attribute: string, filter: string, link = ''): string =>
  `<fetch top="5"><entity name="${entity}"><attribute name="${attribute}" />${filter}${link}</entity></fetch>`;

/** Looks up the SDK message id and any existing step for this expression so redeploys update in place. */
async function resolveBinding(spec: PluginSpec, environmentUrl: string, dataverse: DataverseClient): Promise<AutomatedBinding> {
  const trigger = spec.trigger!;
  const messages = await dataverse.fetchIds(
    environmentUrl,
    'sdkmessages',
    fetchXml('sdkmessage', 'sdkmessageid', `<filter><condition attribute="name" operator="eq" value="${xmlEscape(trigger.message)}" /></filter>`),
    'sdkmessageid',
  );
  if (messages.length !== 1) {
    throw new Error(`Could not resolve a single SDK message id for "${trigger.message}".`);
  }
  const steps = await dataverse.fetchIds(
    environmentUrl,
    'sdkmessageprocessingsteps',
    fetchXml(
      'sdkmessageprocessingstep',
      'sdkmessageprocessingstepid',
      '',
      `<link-entity name="fxexpression" from="fxexpressionid" to="fxexpressionid"><filter><condition attribute="uniquename" operator="eq" value="${xmlEscape(spec.uniqueName)}" /></filter></link-entity>`,
    ),
    'sdkmessageprocessingstepid',
  );
  if (steps.length > 1) {
    throw new Error('More than one existing step is linked to this expression; fix it in the environment before redeploying.');
  }
  return { sdkMessageId: messages[0]!, stepId: steps[0] ?? defaultStepId(spec) };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const messageOf = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);

/** Maker portal link for commercial-cloud environments only; other clouds use different portal hosts. */
export function solutionPortalUrl(environment: Environment, solutionId: string): string | undefined {
  const commercial = /\.crm\d*\.dynamics\.com\/$/.test(environment.url) && !/\.crm9\.dynamics\.com\/$/.test(environment.url);
  return commercial && /^(Default-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(environment.id) && GUID.test(solutionId)
    ? `https://make.powerapps.com/environments/${environment.id}/solutions/${solutionId}`
    : undefined;
}

/** Step 4: check → confirm environment → (automated) resolve ids → build solution → pac solution pack → import. */
export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const steps: DeployStep[] = [];
  const report = (): void => options.onProgress?.(steps.map((s) => ({ ...s })));
  const begin = (step: string, detail: string): DeployStep => {
    const entry: DeployStep = { step, status: 'running', detail };
    steps.push(entry);
    report();
    return entry;
  };
  const end = (entry: DeployStep, status: StepStatus, detail: string): void => {
    entry.status = status;
    entry.detail = detail;
    report();
  };
  const result = (status: DeployResult['status'], environment: Environment | undefined, issues: Issue[] = []): DeployResult => ({
    status,
    environment,
    steps,
    issues,
  });

  const checked = checkSpecText(options.specText);
  const checkStep = begin('check', 'Checking…');
  if (!checked.ok || checked.spec === undefined) {
    end(checkStep, 'blocked', 'Fix the errors reported by check first.');
    return result('blocked', undefined, checked.issues);
  }
  const spec = checked.spec;
  end(checkStep, 'done', `${checked.issues.length} warning(s).`);

  const environmentStep = begin('environment', 'Looking up the environment…');
  let environments: Environment[];
  try {
    environments = await options.dataverse.environments();
  } catch (error) {
    end(environmentStep, 'blocked', `Could not list environments: ${messageOf(error, 'unknown error')}`);
    return result('blocked', undefined, checked.issues);
  }
  const environment = findEnvironment(environments, options.environment);
  if (typeof environment === 'string') {
    const detail =
      environment === 'ambiguous'
        ? 'More than one environment matches; use the environment URL.'
        : 'Environment is not available to the signed-in account (use a URL, name or id from envs).';
    end(environmentStep, 'blocked', detail);
    return result('blocked', undefined, checked.issues);
  }
  const url = environment.url;
  end(environmentStep, 'done', `${environment.name || environment.url} (type: ${environment.type}).`);

  let binding: AutomatedBinding | undefined;
  if (spec.kind === 'automated') {
    const resolveStep = begin('resolve', `Looking up the ${spec.trigger!.message} message and any existing step…`);
    try {
      binding = await resolveBinding(spec, url, options.dataverse);
      end(resolveStep, 'done', `Message ${spec.trigger!.message} → step ${binding.stepId}.`);
    } catch (error) {
      end(resolveStep, 'failed', messageOf(error, 'Lookup failed.'));
      return result('failed', environment, checked.issues);
    }
  }

  const packStep = begin('pack', 'Packing the solution…');
  let zip: Buffer;
  try {
    const files = buildSolutionFiles(spec, binding);
    zip = packSolution(files);
    if (options.outDir !== undefined) {
      await writeSolutionFolder(files, join(options.outDir, 'solution'));
      await writeFile(join(options.outDir, `${spec.solution.uniqueName}.zip`), zip);
    }
  } catch (error) {
    end(packStep, 'failed', messageOf(error, 'Packing failed.'));
    return result('failed', environment, checked.issues);
  }
  end(packStep, 'done', options.outDir === undefined ? `Solution packed (${zip.length} bytes).` : join(options.outDir, `${spec.solution.uniqueName}.zip`));

  const importStep = begin('import', 'Uploading the solution…');
  try {
    const imported = await options.dataverse.importSolution(url, zip, (detail) => {
      importStep.detail = detail;
      report();
    });
    if (!imported.ok) {
      end(importStep, 'failed', imported.detail);
      return result('failed', environment, checked.issues);
    }
  } catch (error) {
    end(importStep, 'failed', messageOf(error, 'Import failed.'));
    return result('failed', environment, checked.issues);
  }
  end(importStep, 'done', `Imported into ${spec.solution.uniqueName}.`);
  const solutionId = await options.dataverse.solutionId(url, spec.solution.uniqueName).catch(() => undefined);
  const solutionUrl = solutionId === undefined ? undefined : solutionPortalUrl(environment, solutionId);
  return { ...result('succeeded', environment, checked.issues), ...(solutionUrl === undefined ? {} : { solutionUrl }) };
}
