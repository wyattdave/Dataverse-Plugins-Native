import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const SKILL_NAME = 'dataverse-plugins-native';

/** Verified official discovery locations, 2026-10-18. See docs/distribution.md. */
export const SKILL_TARGETS = {
  shared: { user: ['.agents', 'skills'], project: ['.agents', 'skills'] },
  codex: { user: ['.agents', 'skills'], project: ['.agents', 'skills'] },
  claude: { user: ['.claude', 'skills'], project: ['.claude', 'skills'] },
  vscode: { user: ['.copilot', 'skills'], project: ['.github', 'skills'] },
  opencode: { user: ['.agents', 'skills'], project: ['.agents', 'skills'] },
} as const;

export type SkillTarget = keyof typeof SKILL_TARGETS;

export function skillDestinations(target = 'shared', project?: string, home = homedir()): string[] {
  const targets: SkillTarget[] = target === 'all' ? ['codex', 'claude', 'vscode', 'opencode'] : [];
  if (target !== 'all') {
    if (!Object.hasOwn(SKILL_TARGETS, target)) {
      throw new Error(`Unsupported target "${target}". Choose shared, codex, claude, vscode, opencode or all.`);
    }
    targets.push(target as SkillTarget);
  }
  return [...new Set(targets.map((name) => {
    const mapping = SKILL_TARGETS[name];
    return join(resolve(project ?? home), ...(project === undefined ? mapping.user : mapping.project), SKILL_NAME);
  }))];
}
