import type { ActorContext } from '@maoeh/shared-types';
import type { Organization } from '@maoeh/organization-model';
import { createOrgGraph, isExecutableEmployment } from '@maoeh/organization-model';

export interface ActorLegitimacyIssue {
  readonly field: string;
  readonly reason: string;
}

export function validateActorLegitimacy(
  organization: Organization,
  actor: ActorContext,
): readonly ActorLegitimacyIssue[] {
  const issues: ActorLegitimacyIssue[] = [];
  if (actor.employeeId === '') {
    issues.push({ field: 'actor.employeeId', reason: 'employeeId must not be empty' });
  }
  if (actor.positionId === '') {
    issues.push({ field: 'actor.positionId', reason: 'positionId must not be empty' });
  }
  if (actor.correlationId === '') {
    issues.push({ field: 'actor.correlationId', reason: 'correlationId must not be empty' });
  }
  if (issues.length > 0) return issues;

  const graph = createOrgGraph(organization);
  const employee = graph.getEmployee(actor.employeeId);
  if (employee === null) {
    issues.push({
      field: 'actor.employeeId',
      reason: `employee "${actor.employeeId}" does not exist in this organization`,
    });
    return issues;
  }
  if (employee.companyId !== organization.company.id) {
    issues.push({
      field: 'actor.employeeId',
      reason: `employee "${actor.employeeId}" belongs to company "${employee.companyId}", not "${organization.company.id}"`,
    });
  }
  if (employee.positionId !== actor.positionId) {
    issues.push({
      field: 'actor.positionId',
      reason: `actor claims position "${actor.positionId}" but employee "${actor.employeeId}" holds "${employee.positionId}"`,
    });
    return issues;
  }
  const position = graph.getPosition(employee.positionId);
  if (position !== null && (position.departmentId ?? null) !== (actor.departmentId ?? null)) {
    issues.push({
      field: 'actor.departmentId',
      reason: `actor department "${actor.departmentId ?? 'null'}" does not match position department "${position.departmentId ?? 'null'}"`,
    });
  }
  if (!isExecutableEmployment(employee.status)) {
    issues.push({
      field: 'actor.employeeId',
      reason: `employee "${actor.employeeId}" has employment status "${employee.status}" and cannot act`,
    });
  }
  return issues;
}
