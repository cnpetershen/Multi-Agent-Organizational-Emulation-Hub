import type { Result } from '@maoeh/shared-types';
import { parse as parseYaml } from 'yaml';
import type { CognitionProfile, CognitionProfileSource, CognitionSourceReader } from './profile.js';
import { cognitionProfileSourceSchema } from './profile.js';

export interface CognitionProfileIssue {
  readonly source: string;
  readonly field: string;
  readonly reason: string;
}

export interface CognitionProfileFailure {
  readonly issues: readonly CognitionProfileIssue[];
}

export interface LoadCognitionProfilesOptions {
  readonly reader: CognitionSourceReader;
  readonly directory?: string;
}

const DEFAULT_DIRECTORY = 'cognition';

type ReadOutcome = { readonly ok: true; readonly document: unknown } | { readonly ok: false };

async function readDocument(
  reader: CognitionSourceReader,
  source: string,
  issues: CognitionProfileIssue[],
): Promise<ReadOutcome> {
  const raw = await reader.read(source);
  if (raw === null || raw === undefined) {
    issues.push({ source, field: 'content', reason: 'file is empty or missing' });
    return { ok: false };
  }
  if (typeof raw !== 'string') return { ok: true, document: raw };
  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ source, field: 'yaml', reason: message });
    return { ok: false };
  }
  if (document === null || document === undefined) {
    issues.push({ source, field: 'content', reason: 'file is empty or missing' });
    return { ok: false };
  }
  return { ok: true, document };
}

function toCognitionProfile(source: CognitionProfileSource): CognitionProfile {
  return {
    id: source.id,
    reasoningStyle: source.reasoning_style,
    planningStyle: source.planning_style,
    decisionFramework: source.decision_framework,
    reflectionPolicy: source.reflection_policy,
  };
}

export async function loadCognitionProfiles(
  options: LoadCognitionProfilesOptions,
): Promise<Result<readonly CognitionProfile[], CognitionProfileFailure>> {
  const directory = options.directory ?? DEFAULT_DIRECTORY;
  const issues: CognitionProfileIssue[] = [];
  const profiles: CognitionProfile[] = [];
  const seenIds = new Set<string>();
  const paths = [...(await options.reader.list(directory))].sort();

  for (const path of paths) {
    const outcome = await readDocument(options.reader, path, issues);
    if (!outcome.ok) continue;
    const parsed = cognitionProfileSourceSchema.safeParse(outcome.document);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.map((segment) => String(segment)).join('.');
        issues.push({
          source: path,
          field: field === '' ? 'profile' : field,
          reason: issue.message,
        });
      }
      continue;
    }
    if (seenIds.has(parsed.data.id)) {
      issues.push({
        source: path,
        field: 'id',
        reason: `duplicate cognition profile id "${parsed.data.id}"`,
      });
    }
    seenIds.add(parsed.data.id);
    profiles.push(toCognitionProfile(parsed.data));
  }

  if (issues.length > 0) return { ok: false, error: { issues } };
  return { ok: true, value: profiles };
}
