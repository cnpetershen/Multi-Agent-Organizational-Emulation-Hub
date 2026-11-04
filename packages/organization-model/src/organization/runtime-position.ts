import type { AuthorityLevel, DepartmentId, PositionId } from '@maoeh/shared-types';
import type { Position } from '../position/position.js';
import type { Organization } from '../organization/organization.js';

/**
 * Positions created at runtime — `Agent.Create` with a title the chart does not have yet
 * ("Organization | Engineering | Game Developer").
 *
 * The seed chart is YAML, but a chart row is ordinary organization state, so the same builder
 * feeds both the live command path and the event-log replay that reconstructs it. Reports
 * default to the department's head seat (the same `reports_to` the seed rows use), the
 * department must already exist — a command adds *positions*, never departments — and the
 * caller owns rollback: the kernel pushes the row only once every later step can succeed,
 * exactly like it does for the employee row.
 */

export type RuntimePositionFailure =
  | { readonly code: 'unknown_department'; readonly reason: string }
  | { readonly code: 'duplicate_position'; readonly reason: string };

export interface RuntimePositionSpec {
  /** Position id — usually the console's slug of the typed title (same rule as employeeId). */
  readonly positionId: string;
  readonly title: string;
  readonly departmentId: string;
  /** Capability tags the new seat provides for capability → position routing. */
  readonly capabilities?: readonly string[];
  /** Explicit manager seat; defaults to the department head position. */
  readonly reportsToPositionId?: string | null;
  readonly authorityLevel?: AuthorityLevel;
}

export type BuildRuntimePositionResult =
  | { readonly ok: true; readonly value: Position }
  | { readonly ok: false; readonly error: RuntimePositionFailure };

export function buildRuntimePosition(
  organization: Organization,
  spec: RuntimePositionSpec,
): BuildRuntimePositionResult {
  if (organization.positions.some((position) => String(position.id) === spec.positionId)) {
    return {
      ok: false,
      error: {
        code: 'duplicate_position',
        reason: `position "${spec.positionId}" already exists in this organization`,
      },
    };
  }
  const department = organization.departments.find(
    (entry) => String(entry.id) === spec.departmentId,
  );
  if (department === undefined) {
    return {
      ok: false,
      error: {
        code: 'unknown_department',
        reason: `department "${spec.departmentId}" does not exist in this organization`,
      },
    };
  }
  const reportsTo =
    spec.reportsToPositionId === undefined
      ? (department.headPositionId ?? null)
      : spec.reportsToPositionId;
  const capabilities = (spec.capabilities ?? []).map((entry) =>
    entry.trim().toLowerCase(),
  );
  const position: Position = {
    id: spec.positionId as PositionId,
    companyId: organization.company.id,
    departmentId: spec.departmentId as DepartmentId,
    reportsToPositionId: reportsTo === null ? null : (reportsTo as PositionId),
    title: spec.title,
    ...(spec.authorityLevel === undefined ? {} : { authorityLevel: spec.authorityLevel }),
    ...(capabilities.length === 0
      ? {}
      : { capabilities: Object.freeze([...new Set(capabilities)]) }),
  };
  return { ok: true, value: position };
}
