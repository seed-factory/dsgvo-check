/** Turns a list of changed paths into a test plan: a full run or the files to hand to `vitest related`. */
import path from 'node:path';
import { RULES } from './rules.ts';

export type Plan =
  | { mode: 'full'; reasons: string[] }
  | { mode: 'selective'; related: string[]; reasons: string[] };

export type PlanContext = { files: string[]; consumers: Map<string, Set<string>> };

const DATA_ROOT = 'test/data/';

const matches = (file: string, globs: string[]) => globs.some((glob) => path.posix.matchesGlob(file, glob));

export function planRun(changed: string[], ctx: PlanContext): Plan {
  const fullReasons: string[] = [];
  const reasons: string[] = [];
  const related = new Set<string>();

  for (const file of changed) {
    const rules = RULES.filter((rule) => matches(file, rule.globs));
    if (rules.length === 0) {
      fullReasons.push(`${file}: no rule`);
      continue;
    }

    const isCode = rules.some((rule) => rule.effect.kind === 'code');
    const found = new Set<string>();
    const notes: string[] = [];
    for (const { effect } of rules) {
      switch (effect.kind) {
        case 'full':
          fullReasons.push(`${file}: ${effect.reason}`);
          break;
        case 'none':
          notes.push(effect.reason);
          break;
        case 'code':
          found.add(file);
          break;
        case 'readers':
          for (const reader of ctx.files.filter((candidate) => matches(candidate, effect.globs))) {
            found.add(reader);
          }
          notes.push(effect.reason);
          break;
        case 'data': {
          const entry = file.slice(DATA_ROOT.length).split('/')[0] as string;
          const users = ctx.consumers.get(entry);
          if (!users || users.size === 0) {
            fullReasons.push(`${file}: no reader found for ${DATA_ROOT}${entry}`);
          } else {
            for (const user of users) found.add(user);
            notes.push(`${users.size} readers of ${DATA_ROOT}${entry}`);
          }
          break;
        }
      }
    }

    for (const item of found) related.add(item);
    if (!isCode) reasons.push(`${file}: ${notes.join(', ') || 'no tests'}`);
  }

  if (fullReasons.length > 0) return { mode: 'full', reasons: fullReasons };
  return { mode: 'selective', related: [...related].sort(), reasons };
}
