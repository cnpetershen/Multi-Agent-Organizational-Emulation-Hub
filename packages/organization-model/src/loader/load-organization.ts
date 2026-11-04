import { parse, YAMLParseError } from 'yaml';
import { z } from 'zod';
import type {
  AuthorityLevel,
  CompanyId,
  DecisionDomain,
  DepartmentId,
  EmployeeId,
  PositionId,
  Result,
} from '@maoeh/shared-types';
import type { Company } from '../company/company.js';
import type { Department } from '../department/department.js';
import type { Employee } from '../employee/employee.js';
import type { Organization } from '../organization/organization.js';
import type { Position } from '../position/position.js';
import type { OrgEntityType, OrgLoadFailure, OrgLoadIssue } from './errors.js';
import type { OrganizationSourceReader } from './organization-source-reader.js';
import {
  companySchema,
  decisionDomainsSchema,
  departmentSchema,
  employeeSchema,
  positionSchema,
} from './schemas.js';
import { validateOrganization } from './validate-organization.js';

const COMPANY_FILE = 'company.yaml';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRawId(document: unknown): string | undefined {
  if (typeof document === 'object' && document !== null && 'id' in document) {
    const id: unknown = (document as { id: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function yamlParseIssue(
  error: unknown,
  source: string,
  entityType: OrgEntityType,
): OrgLoadIssue {
  if (error instanceof YAMLParseError) {
    const positioned = error as unknown as {
      linePos?: Array<{ line: number; col: number }>;
    };
    const position = positioned.linePos?.[0];
    return {
      source,
      entityType,
      reason: error.message.split('\n')[0] ?? error.message,
      ...(position !== undefined && {
        line: position.line,
        column: position.col,
      }),
    };
  }
  return { source, entityType, reason: messageOf(error) };
}

function parseEntityFile<S extends z.ZodType>(
  reader: OrganizationSourceReader,
  source: string,
  entityType: OrgEntityType,
  schema: S,
): { entity: z.infer<S> | null; issues: OrgLoadIssue[] } {
  let text: string | null;
  try {
    text = reader.read(source);
  } catch (error) {
    return {
      entity: null,
      issues: [{ source, entityType, reason: `unreadable: ${messageOf(error)}` }],
    };
  }
  if (text === null) {
    return {
      entity: null,
      issues: [{ source, entityType, reason: 'file not found' }],
    };
  }
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    return { entity: null, issues: [yamlParseIssue(error, source, entityType)] };
  }
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    const entityId = readRawId(document);
    return {
      entity: null,
      issues: parsed.error.issues.map((issue) => {
        const loadIssue: OrgLoadIssue = { source, entityType, reason: issue.message };
        if (entityId !== undefined) loadIssue.entityId = entityId;
        if (issue.code === 'unrecognized_keys') {
          loadIssue.field = issue.keys.join(', ');
        } else if (issue.path.length > 0) {
          loadIssue.field = issue.path.map(String).join('.');
        }
        return loadIssue;
      }),
    };
  }
  return { entity: parsed.data, issues: [] };
}

function loadDirectory<S extends z.ZodType>(
  reader: OrganizationSourceReader,
  directory: string,
  entityType: OrgEntityType,
  schema: S,
  idOf: (entity: z.infer<S>) => string,
  sources: Map<string, string>,
  issues: OrgLoadIssue[],
): z.infer<S>[] {
  let listed: readonly string[];
  try {
    listed = reader.list(directory);
  } catch (error) {
    issues.push({
      source: directory,
      entityType,
      reason: `unreadable: ${messageOf(error)}`,
    });
    return [];
  }
  const entities: z.infer<S>[] = [];
  for (const file of [...listed].sort()) {
    const result = parseEntityFile(reader, file, entityType, schema);
    issues.push(...result.issues);
    if (result.entity === null) continue;
    const id = idOf(result.entity);
    const key = `${entityType}:${id}`;
    const existing = sources.get(key);
    if (existing !== undefined) {
      issues.push({
        source: file,
        entityType,
        entityId: id,
        reason: `duplicate ${entityType} id "${id}", already defined in "${existing}"`,
      });
      continue;
    }
    sources.set(key, file);
    entities.push(result.entity);
  }
  return entities;
}

function toDecisionDomains(
  raw: z.infer<typeof decisionDomainsSchema>,
): Partial<Record<DecisionDomain, AuthorityLevel>> {
  return {
    ...(raw.engineering !== undefined && { engineering: raw.engineering }),
    ...(raw.product !== undefined && { product: raw.product }),
    ...(raw.ops !== undefined && { ops: raw.ops }),
    ...(raw.marketing !== undefined && { marketing: raw.marketing }),
    ...(raw.finance !== undefined && { finance: raw.finance }),
    ...(raw.org !== undefined && { org: raw.org }),
  };
}

function toCompany(raw: z.infer<typeof companySchema>): Company {
  return {
    id: raw.id as CompanyId,
    name: raw.name,
    ...(raw.mission !== undefined && { mission: raw.mission }),
    ...(raw.strategy !== undefined && { strategy: raw.strategy }),
    ...(raw.founded_sim_day !== undefined && {
      foundedSimDay: raw.founded_sim_day,
    }),
  };
}

function toDepartment(
  raw: z.infer<typeof departmentSchema>,
  companyId: CompanyId,
): Department {
  return {
    id: raw.id as DepartmentId,
    companyId,
    parent: raw.parent !== undefined ? (raw.parent as DepartmentId) : null,
    name: raw.name,
    headPositionId:
      raw.head_position !== undefined ? (raw.head_position as PositionId) : null,
    ...(raw.key !== undefined && { key: raw.key }),
    ...(raw.budget !== undefined && { budget: raw.budget }),
  };
}

/**
 * Tag ids are compared case-insensitively during capability matching, so both a seat's
 * capabilities and a person's expertise are normalized once, at the loading boundary:
 * trimmed, lowercased, deduped, input order preserved.
 */
function normalizeTags(values: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.map((entry) => entry.trim().toLowerCase()))].filter(
      (entry) => entry !== '',
    ),
  );
}

function toPosition(
  raw: z.infer<typeof positionSchema>,
  companyId: CompanyId,
): Position {
  return {
    id: raw.id as PositionId,
    companyId,
    departmentId:
      raw.department !== undefined ? (raw.department as DepartmentId) : null,
    reportsToPositionId:
      raw.reports_to !== undefined ? (raw.reports_to as PositionId) : null,
    title: raw.title,
    ...(raw.key !== undefined && { key: raw.key }),
    ...(raw.role_code !== undefined && { roleCode: raw.role_code }),
    ...(raw.authority_level !== undefined && { authorityLevel: raw.authority_level }),
    ...(raw.responsibilities !== undefined && {
      responsibilities: raw.responsibilities,
    }),
    ...(raw.required_skills !== undefined && { requiredSkills: raw.required_skills }),
    ...(raw.headcount !== undefined && { headcount: raw.headcount }),
    ...(raw.status !== undefined && { status: raw.status }),
    ...(raw.decision_domains !== undefined && {
      decisionDomains: toDecisionDomains(raw.decision_domains),
    }),
    ...(raw.capabilities !== undefined && { capabilities: normalizeTags(raw.capabilities) }),
  };
}

function toEmployee(
  raw: z.infer<typeof employeeSchema>,
  companyId: CompanyId,
): Employee {
  return {
    id: raw.id as EmployeeId,
    companyId,
    positionId: raw.position as PositionId,
    name: raw.name,
    status: raw.status ?? 'defined',
    ...(raw.employee_no !== undefined && { employeeNo: raw.employee_no }),
    ...(raw.kind !== undefined && { kind: raw.kind }),
    ...(raw.attributes !== undefined && { attributes: raw.attributes }),
    ...(raw.expertise !== undefined && { expertise: normalizeTags(raw.expertise) }),
  };
}

function compareById(
  a: { id: string },
  b: { id: string },
): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function loadOrganization(
  reader: OrganizationSourceReader,
): Result<Organization, OrgLoadFailure> {
  const issues: OrgLoadIssue[] = [];
  const sources = new Map<string, string>();

  const companyResult = parseEntityFile(
    reader,
    COMPANY_FILE,
    'company',
    companySchema,
  );
  issues.push(...companyResult.issues);
  if (companyResult.entity === null) return { ok: false, error: { issues } };
  sources.set(`company:${companyResult.entity.id}`, COMPANY_FILE);

  const departmentYaml = loadDirectory(
    reader,
    'departments',
    'department',
    departmentSchema,
    (entity) => entity.id,
    sources,
    issues,
  );
  const positionYaml = loadDirectory(
    reader,
    'positions',
    'position',
    positionSchema,
    (entity) => entity.id,
    sources,
    issues,
  );
  const employeeYaml = loadDirectory(
    reader,
    'employees',
    'employee',
    employeeSchema,
    (entity) => entity.id,
    sources,
    issues,
  );

  if (issues.length > 0) return { ok: false, error: { issues } };

  const companyId = companyResult.entity.id as CompanyId;
  const organization: Organization = {
    company: toCompany(companyResult.entity),
    departments: departmentYaml
      .map((raw) => toDepartment(raw, companyId))
      .sort(compareById),
    positions: positionYaml
      .map((raw) => toPosition(raw, companyId))
      .sort(compareById),
    employees: employeeYaml
      .map((raw) => toEmployee(raw, companyId))
      .sort(compareById),
  };

  const validationIssues = validateOrganization(organization, sources);
  if (validationIssues.length > 0) {
    return { ok: false, error: { issues: validationIssues } };
  }
  return { ok: true, value: organization };
}
