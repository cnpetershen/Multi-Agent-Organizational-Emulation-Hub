import type { DepartmentId, EmployeeId, PositionId } from '@maoeh/shared-types';
import type { Organization } from '../organization/organization.js';
import type { OrgEntityType, OrgLoadIssue } from './errors.js';

function findCycle<TId extends string>(
  parentOf: ReadonlyMap<TId, TId | null>,
): TId[] | null {
  const done = new Set<TId>();
  for (const start of parentOf.keys()) {
    if (done.has(start)) continue;
    const chain: TId[] = [];
    const indexInChain = new Map<TId, number>();
    let current: TId | undefined = start;
    while (
      current !== undefined &&
      !done.has(current) &&
      !indexInChain.has(current)
    ) {
      indexInChain.set(current, chain.length);
      chain.push(current);
      const parent: TId | null | undefined = parentOf.get(current);
      current = parent === undefined || parent === null ? undefined : parent;
    }
    for (const id of chain) done.add(id);
    if (current !== undefined && indexInChain.has(current)) {
      const from = indexInChain.get(current);
      if (from !== undefined) return [...chain.slice(from), current];
    }
  }
  return null;
}

export function validateOrganization(
  organization: Organization,
  sources: ReadonlyMap<string, string>,
): readonly OrgLoadIssue[] {
  const issues: OrgLoadIssue[] = [];
  const sourceOf = (entityType: OrgEntityType, entityId: string): string =>
    sources.get(`${entityType}:${entityId}`) ?? '<organization>';

  const departmentIds = new Set(
    organization.departments.map((department) => department.id),
  );
  const positionIds = new Set(organization.positions.map((position) => position.id));

  for (const position of organization.positions) {
    if (position.departmentId !== null && !departmentIds.has(position.departmentId)) {
      issues.push({
        source: sourceOf('position', position.id),
        entityType: 'position',
        entityId: position.id,
        field: 'department',
        reason: `unknown department "${position.departmentId}"`,
      });
    }
    if (position.reportsToPositionId !== null) {
      if (position.reportsToPositionId === position.id) {
        issues.push({
          source: sourceOf('position', position.id),
          entityType: 'position',
          entityId: position.id,
          field: 'reports_to',
          reason: 'a position cannot report to itself',
        });
      } else if (!positionIds.has(position.reportsToPositionId)) {
        issues.push({
          source: sourceOf('position', position.id),
          entityType: 'position',
          entityId: position.id,
          field: 'reports_to',
          reason: `unknown position "${position.reportsToPositionId}"`,
        });
      }
    }
  }

  for (const department of organization.departments) {
    if (department.parent !== null) {
      if (department.parent === department.id) {
        issues.push({
          source: sourceOf('department', department.id),
          entityType: 'department',
          entityId: department.id,
          field: 'parent',
          reason: 'a department cannot be its own parent',
        });
      } else if (!departmentIds.has(department.parent)) {
        issues.push({
          source: sourceOf('department', department.id),
          entityType: 'department',
          entityId: department.id,
          field: 'parent',
          reason: `unknown department "${department.parent}"`,
        });
      }
    }
    if (
      department.headPositionId !== null &&
      !positionIds.has(department.headPositionId)
    ) {
      issues.push({
        source: sourceOf('department', department.id),
        entityType: 'department',
        entityId: department.id,
        field: 'head_position',
        reason: `unknown position "${department.headPositionId}"`,
      });
    }
  }

  const holderByPosition = new Map<PositionId, EmployeeId>();
  for (const employee of organization.employees) {
    if (!positionIds.has(employee.positionId)) {
      issues.push({
        source: sourceOf('employee', employee.id),
        entityType: 'employee',
        entityId: employee.id,
        field: 'position',
        reason: `unknown position "${employee.positionId}"`,
      });
      continue;
    }
    const holder = holderByPosition.get(employee.positionId);
    if (holder !== undefined) {
      issues.push({
        source: sourceOf('employee', employee.id),
        entityType: 'employee',
        entityId: employee.id,
        field: 'position',
        reason: `position "${employee.positionId}" is already held by employee "${holder}"`,
      });
    } else {
      holderByPosition.set(employee.positionId, employee.id);
    }
  }

  const reportsToOfPosition = new Map<PositionId, PositionId | null>();
  for (const position of organization.positions) {
    const target = position.reportsToPositionId;
    reportsToOfPosition.set(
      position.id,
      target !== null && target !== position.id && positionIds.has(target)
        ? target
        : null,
    );
  }
  const positionCycle = findCycle(reportsToOfPosition);
  if (positionCycle !== null) {
    const entry = positionCycle[0];
    if (entry !== undefined) {
      issues.push({
        source: sourceOf('position', entry),
        entityType: 'position',
        entityId: entry,
        field: 'reports_to',
        reason: `reporting cycle: ${positionCycle.join(' -> ')}`,
      });
    }
  }

  const parentOfDepartment = new Map<DepartmentId, DepartmentId | null>();
  for (const department of organization.departments) {
    const parent = department.parent;
    parentOfDepartment.set(
      department.id,
      parent !== null && parent !== department.id && departmentIds.has(parent)
        ? parent
        : null,
    );
  }
  const departmentCycle = findCycle(parentOfDepartment);
  if (departmentCycle !== null) {
    const entry = departmentCycle[0];
    if (entry !== undefined) {
      issues.push({
        source: sourceOf('department', entry),
        entityType: 'department',
        entityId: entry,
        field: 'parent',
        reason: `department parent cycle: ${departmentCycle.join(' -> ')}`,
      });
    }
  }

  return issues;
}
