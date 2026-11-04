import type { CompanyId, EmployeeId, PositionId } from '@maoeh/shared-types';

export type EmployeeKind = 'agent' | 'human';

export type EmployeeStatus =
  | 'defined'
  | 'onboarding'
  | 'active'
  | 'on_leave'
  | 'suspended'
  | 'transferred'
  | 'offboarded';

/**
 * Employment states in which the person no longer *carries* their seat's work: the record stays
 * on the roster (M1.3 never deletes — the status is the fact), but the seat is effectively open.
 *
 * This is the canonical list, because three readers ask the identical question — "is there
 * someone executable in this seat?" — and had each grown their own copy: seat-holder resolution
 * (`createOrgGraph`), task assignment (`TaskService`) and workflow step entry (`WorkflowEngine`).
 *
 * `on_leave` is deliberately **not** here: a person on leave still holds their seat, so reporting
 * lines and seat occupancy stay intact — they are merely unavailable for *new* work, which is
 * `isEmploymentAvailable`'s narrower question.
 */
export const NON_EXECUTABLE_EMPLOYMENT_STATUSES: ReadonlySet<EmployeeStatus> = new Set<EmployeeStatus>([
  'suspended',
  'transferred',
  'offboarded',
]);

/** `false` when the person can no longer be given or carry their seat's work. */
export function isExecutableEmployment(status: string): boolean {
  return !NON_EXECUTABLE_EMPLOYMENT_STATUSES.has(status as EmployeeStatus);
}

export interface Employee {
  id: EmployeeId;
  companyId: CompanyId;
  positionId: PositionId;
  employeeNo?: string;
  name: string;
  kind?: EmployeeKind;
  status: EmployeeStatus;
  /**
   * Fine-grained specializations this *person* brings (e.g. `typescript`, `react`, `seo`).
   *
   * Distinct from `Position.capabilities`: the seat says what work the *seat* owns and is the
   * routing contract; expertise says what the *holder* is especially good at. Capability matching
   * satisfies a requirement from either side, so a person can be a candidate for work their seat
   * does not formally declare — while the seat's declared tags stay the default, explainable route.
   *
   * Additive and optional, so the seed chart and every existing reader are unchanged.
   */
  expertise?: readonly string[];
}
