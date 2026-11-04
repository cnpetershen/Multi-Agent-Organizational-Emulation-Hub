import type { DepartmentId, EmployeeId, PositionId, Result } from '@maoeh/shared-types';
import type { Organization } from '@maoeh/organization-model';
import { parse as parseYaml } from 'yaml';
import { agentDefinitionSourceSchema } from './schemas.js';
import type { AgentDefinitionSource } from './schemas.js';
import type { AgentDefinitionSourceReader } from './source-reader.js';
import type { AgentDefinition } from './types.js';

export interface AgentDefinitionIssue {
  readonly source: string;
  readonly field: string;
  readonly reason: string;
}

export interface AgentDefinitionFailure {
  readonly issues: readonly AgentDefinitionIssue[];
}

export interface LoadAgentDefinitionsOptions {
  readonly reader: AgentDefinitionSourceReader;
  readonly organization: Organization;
  readonly cognitionProfileIds: readonly string[];
  readonly directory?: string;
}

const DEFAULT_DIRECTORY = 'agent-definitions';

type ReadOutcome = { readonly ok: true; readonly document: unknown } | { readonly ok: false };

async function readDocument(
  reader: AgentDefinitionSourceReader,
  source: string,
  issues: AgentDefinitionIssue[],
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

function toAgentDefinition(source: AgentDefinitionSource): AgentDefinition {
  return {
    id: source.id,
    employeeId: source.employee as EmployeeId,
    positionId: source.position as PositionId,
    ...(source.department !== undefined
      ? { departmentId: source.department as DepartmentId }
      : {}),
    identity: {
      name: source.identity.name,
      ...(source.identity.description !== undefined
        ? { description: source.identity.description }
        : {}),
      traits: source.identity.traits,
    },
    responsibilities: source.responsibilities,
    capabilities: source.capabilities,
    cognitionProfileId: source.cognition_profile,
    memoryPolicy: source.memory_policy,
    toolPolicy: source.tool_policy,
  };
}

export async function loadAgentDefinitions(
  options: LoadAgentDefinitionsOptions,
): Promise<Result<readonly AgentDefinition[], AgentDefinitionFailure>> {
  const directory = options.directory ?? DEFAULT_DIRECTORY;
  const issues: AgentDefinitionIssue[] = [];
  const definitions: AgentDefinition[] = [];
  const seenIds = new Set<string>();
  const seenEmployees = new Set<string>();
  const paths = [...(await options.reader.list(directory))].sort();

  for (const path of paths) {
    const outcome = await readDocument(options.reader, path, issues);
    if (!outcome.ok) continue;
    const parsed = agentDefinitionSourceSchema.safeParse(outcome.document);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.map((segment) => String(segment)).join('.');
        issues.push({
          source: path,
          field: field === '' ? 'definition' : field,
          reason: issue.message,
        });
      }
      continue;
    }
    const source = parsed.data;
    if (seenIds.has(source.id)) {
      issues.push({
        source: path,
        field: 'id',
        reason: `duplicate agent definition id "${source.id}"`,
      });
    }
    if (seenEmployees.has(source.employee)) {
      issues.push({
        source: path,
        field: 'employee',
        reason: `employee "${source.employee}" already has an agent definition`,
      });
    }
    seenIds.add(source.id);
    seenEmployees.add(source.employee);

    if (!options.organization.employees.some((employee) => employee.id === source.employee)) {
      issues.push({
        source: path,
        field: 'employee',
        reason: `employee "${source.employee}" does not exist in the organization`,
      });
    }
    if (!options.organization.positions.some((position) => position.id === source.position)) {
      issues.push({
        source: path,
        field: 'position',
        reason: `position "${source.position}" does not exist in the organization`,
      });
    }
    if (
      source.department !== undefined &&
      !options.organization.departments.some((department) => department.id === source.department)
    ) {
      issues.push({
        source: path,
        field: 'department',
        reason: `department "${source.department}" does not exist in the organization`,
      });
    }
    if (!options.cognitionProfileIds.includes(source.cognition_profile)) {
      issues.push({
        source: path,
        field: 'cognition_profile',
        reason: `cognition profile "${source.cognition_profile}" does not exist`,
      });
    }

    definitions.push(toAgentDefinition(source));
  }

  if (issues.length > 0) return { ok: false, error: { issues } };
  return { ok: true, value: definitions };
}
