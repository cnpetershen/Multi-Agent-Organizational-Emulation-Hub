import { readNumber, readString, type Row } from './api';

/**
 * M3.3 · 规划台的读模型。
 *
 * The API returns the exact plan/version/orchestration documents; this module narrows them into
 * renderable shapes and never fabricates a missing field. `splitLines` / `joinLines` are the
 * editor's only conversion: a textarea is a list, not a prose blob.
 */

export type RequirementStatus = 'draft' | 'needs_clarification' | 'confirmed';

export interface ClarificationView {
  readonly id: string;
  readonly question: string;
  readonly why: string;
  readonly blocking: boolean;
  readonly answer: string | null;
  readonly status: 'open' | 'answered';
}

export interface RequirementPlanView {
  readonly requirementId: string;
  readonly companyId: string;
  readonly version: number;
  readonly status: RequirementStatus;
  readonly source: { readonly kind: 'goal' | 'sandbox'; readonly sessionId: string | null; readonly goal: string };
  readonly title: string;
  readonly background: string | null;
  readonly audience: readonly string[];
  readonly constraints: readonly string[];
  readonly scope: { readonly inScope: readonly string[]; readonly outOfScope: readonly string[] };
  readonly deliverables: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly risks: readonly { readonly risk: string; readonly mitigation: string | null; readonly severity: string }[];
  readonly requiredCapabilities: readonly string[];
  readonly clarifications: readonly ClarificationView[];
  readonly gaps: readonly { readonly area: string; readonly detail: string; readonly blocking: boolean }[];
  readonly provenance: {
    readonly mode: string;
    readonly provider: string | null;
    readonly model: string | null;
    readonly stated: readonly string[];
    readonly inferred: readonly string[];
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string | null;
}

export interface RequirementRecordView {
  readonly requirementId: string;
  readonly companyId: string;
  readonly currentVersion: number;
  readonly versions: readonly RequirementPlanView[];
}

export interface RequirementSummaryView {
  readonly requirementId: string;
  readonly title: string;
  readonly status: RequirementStatus;
  readonly version: number;
  readonly sourceKind: 'goal' | 'sandbox';
  readonly updatedAt: string;
  readonly deliverableCount: number;
  readonly capabilityCount: number;
}

export interface OrchestrationNodeView {
  readonly nodeId: string;
  readonly kind: 'task' | 'approval';
  readonly title: string;
  readonly capability: string | null;
  readonly employeeId: string | null;
  readonly positionId: string | null;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly acceptance: readonly string[];
  readonly dependsOn: readonly string[];
  readonly order: number;
  readonly status: 'planned' | 'unassigned' | 'human-gate';
}

export interface OrchestrationView {
  readonly orchestrationId: string;
  readonly companyId: string;
  readonly version: number;
  readonly status: 'ready' | 'blocked';
  readonly requirementId: string;
  readonly requirementVersion: number;
  readonly title: string;
  readonly goal: string;
  readonly nodes: readonly OrchestrationNodeView[];
  readonly order: readonly string[];
  readonly conflicts: readonly {
    readonly code: string;
    readonly severity: 'warning' | 'blocking';
    readonly detail: string;
    readonly nodeIds: readonly string[];
  }[];
  readonly missingCapabilities: readonly string[];
  readonly unassignedNodeIds: readonly string[];
  readonly basis: {
    readonly requirementId: string;
    readonly requirementVersion: number;
    readonly capabilities: readonly string[];
    readonly employees: readonly string[];
    readonly rule: string;
  };
  readonly workflowInstanceId: string | null;
  readonly workflowId: string | null;
  readonly workflowVersion: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as readonly unknown[])
        .map((entry) => readString(entry, ''))
        .filter((entry) => entry !== '')
    : [];
}

function objectOf(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function statusOf(value: unknown): RequirementStatus {
  const status = readString(value, 'draft');
  return status === 'confirmed' || status === 'needs_clarification' ? status : 'draft';
}

function clarifications(value: unknown): ClarificationView[] {
  if (!Array.isArray(value)) return [];
  return (value as readonly unknown[]).map((entry) => {
    const row = objectOf(entry);
    return {
      id: readString(row['id'], ''),
      question: readString(row['question'], ''),
      why: readString(row['why'], ''),
      blocking: row['blocking'] === true,
      answer: typeof row['answer'] === 'string' && row['answer'] !== '' ? row['answer'] : null,
      status: row['status'] === 'answered' ? 'answered' : 'open',
    };
  });
}

export function parseRequirementPlan(value: unknown): RequirementPlanView {
  const row = objectOf(value);
  const source = objectOf(row['source']);
  const scope = objectOf(row['scope']);
  const provenance = objectOf(row['provenance']);
  return {
    requirementId: readString(row['requirementId'], ''),
    companyId: readString(row['companyId'], ''),
    version: readNumber(row['version'], 1),
    status: statusOf(row['status']),
    source: {
      kind: source['kind'] === 'sandbox' ? 'sandbox' : 'goal',
      sessionId: typeof source['sessionId'] === 'string' ? source['sessionId'] : null,
      goal: readString(source['goal'], ''),
    },
    title: readString(row['title'], ''),
    background: typeof row['background'] === 'string' ? row['background'] : null,
    audience: strings(row['audience']),
    constraints: strings(row['constraints']),
    scope: { inScope: strings(scope['inScope']), outOfScope: strings(scope['outOfScope']) },
    deliverables: strings(row['deliverables']),
    acceptanceCriteria: strings(row['acceptanceCriteria']),
    risks: Array.isArray(row['risks'])
      ? (row['risks'] as readonly unknown[]).map((entry) => {
          const risk = objectOf(entry);
          return {
            risk: readString(risk['risk'], ''),
            mitigation: typeof risk['mitigation'] === 'string' ? risk['mitigation'] : null,
            severity: readString(risk['severity'], 'medium'),
          };
        })
      : [],
    requiredCapabilities: strings(row['requiredCapabilities']),
    clarifications: clarifications(row['clarifications']),
    gaps: Array.isArray(row['gaps'])
      ? (row['gaps'] as readonly unknown[]).map((entry) => {
          const gap = objectOf(entry);
          return {
            area: readString(gap['area'], ''),
            detail: readString(gap['detail'], ''),
            blocking: gap['blocking'] === true,
          };
        })
      : [],
    provenance: {
      mode: readString(provenance['mode'], 'deterministic'),
      provider: typeof provenance['provider'] === 'string' ? provenance['provider'] : null,
      model: typeof provenance['model'] === 'string' ? provenance['model'] : null,
      stated: strings(provenance['stated']),
      inferred: strings(provenance['inferred']),
    },
    createdAt: readString(row['createdAt'], ''),
    updatedAt: readString(row['updatedAt'], ''),
    confirmedAt: typeof row['confirmedAt'] === 'string' ? row['confirmedAt'] : null,
    confirmedBy: typeof row['confirmedBy'] === 'string' ? row['confirmedBy'] : null,
  };
}

export function parseRequirementRecord(value: unknown): RequirementRecordView {
  const row = objectOf(value);
  const versions = Array.isArray(row['versions'])
    ? (row['versions'] as readonly unknown[]).map(parseRequirementPlan)
    : [];
  return {
    requirementId: readString(row['requirementId'], ''),
    companyId: readString(row['companyId'], ''),
    currentVersion: readNumber(row['currentVersion'], versions.at(-1)?.version ?? 1),
    versions,
  };
}

export function parseRequirementList(value: unknown): RequirementSummaryView[] {
  const row = objectOf(value);
  const list = Array.isArray(value) ? (value as readonly unknown[]) : Array.isArray(row['requirements']) ? (row['requirements'] as readonly unknown[]) : [];
  return list.map((entry) => {
    const item = objectOf(entry);
    return {
      requirementId: readString(item['requirementId'], ''),
      title: readString(item['title'], ''),
      status: statusOf(item['status']),
      version: readNumber(item['version'], 1),
      sourceKind: item['sourceKind'] === 'sandbox' ? 'sandbox' : 'goal',
      updatedAt: readString(item['updatedAt'], ''),
      deliverableCount: readNumber(item['deliverableCount'], 0),
      capabilityCount: readNumber(item['capabilityCount'], 0),
    };
  });
}

export function parseOrchestration(value: unknown): OrchestrationView {
  const row = objectOf(value);
  const nodes = Array.isArray(row['nodes'])
    ? (row['nodes'] as readonly unknown[]).map((entry) => {
        const node = objectOf(entry);
        return {
          nodeId: readString(node['nodeId'], ''),
          kind: node['kind'] === 'approval' ? ('approval' as const) : ('task' as const),
          title: readString(node['title'], ''),
          capability: typeof node['capability'] === 'string' ? node['capability'] : null,
          employeeId: typeof node['employeeId'] === 'string' ? node['employeeId'] : null,
          positionId: typeof node['positionId'] === 'string' ? node['positionId'] : null,
          inputs: strings(node['inputs']),
          outputs: strings(node['outputs']),
          acceptance: strings(node['acceptance']),
          dependsOn: strings(node['dependsOn']),
          order: readNumber(node['order'], 0),
          status:
            node['status'] === 'unassigned'
              ? ('unassigned' as const)
              : node['status'] === 'human-gate'
                ? ('human-gate' as const)
                : ('planned' as const),
        };
      })
    : [];
  const basis = objectOf(row['basis']);
  return {
    orchestrationId: readString(row['orchestrationId'], ''),
    companyId: readString(row['companyId'], ''),
    version: readNumber(row['version'], 1),
    status: row['status'] === 'blocked' ? 'blocked' : 'ready',
    requirementId: readString(row['requirementId'], ''),
    requirementVersion: readNumber(row['requirementVersion'], 1),
    title: readString(row['title'], ''),
    goal: readString(row['goal'], ''),
    nodes,
    order: strings(row['order']),
    conflicts: Array.isArray(row['conflicts'])
      ? (row['conflicts'] as readonly unknown[]).map((entry) => {
          const conflict = objectOf(entry);
          return {
            code: readString(conflict['code'], ''),
            severity: conflict['severity'] === 'blocking' ? ('blocking' as const) : ('warning' as const),
            detail: readString(conflict['detail'], ''),
            nodeIds: strings(conflict['nodeIds']),
          };
        })
      : [],
    missingCapabilities: strings(row['missingCapabilities']),
    unassignedNodeIds: strings(row['unassignedNodeIds']),
    basis: {
      requirementId: readString(basis['requirementId'], ''),
      requirementVersion: readNumber(basis['requirementVersion'], 1),
      capabilities: strings(basis['capabilities']),
      employees: strings(basis['employees']),
      rule: readString(basis['rule'], ''),
    },
    workflowInstanceId: typeof row['workflowInstanceId'] === 'string' ? row['workflowInstanceId'] : null,
    workflowId: typeof row['workflowId'] === 'string' ? row['workflowId'] : null,
    workflowVersion: typeof row['workflowVersion'] === 'number' ? row['workflowVersion'] : null,
    createdAt: readString(row['createdAt'], ''),
    updatedAt: readString(row['updatedAt'], ''),
  };
}

export function parseOrchestrationList(value: unknown): OrchestrationView[] {
  const row = objectOf(value);
  const list = Array.isArray(value)
    ? (value as readonly unknown[])
    : Array.isArray(row['orchestrations'])
      ? (row['orchestrations'] as readonly unknown[])
      : [];
  return list.map(parseOrchestration);
}

/** Textarea → list. Empty lines disappear; whitespace is normalised; duplicates stay once. */
export function splitLines(text: string, max = 30): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const line of text.split('\n')) {
    const value = line.replace(/\s+/g, ' ').trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    list.push(value);
    if (list.length >= max) break;
  }
  return list;
}

export function joinLines(values: readonly string[]): string {
  return values.join('\n');
}

/** The capability editor is comma/newline separated. */
export function splitCapabilities(text: string): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const token of text.split(/[\n,]+/)) {
    const value = token.trim().toLowerCase();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    list.push(value);
    if (list.length >= 12) break;
  }
  return list;
}

export function joinCapabilities(values: readonly string[]): string {
  return values.join(', ');
}

export function requirementStatusTone(status: RequirementStatus): 'ok' | 'warn' | 'neutral' {
  if (status === 'confirmed') return 'ok';
  if (status === 'needs_clarification') return 'warn';
  return 'neutral';
}
