import type {
  AuthorityLevel,
  DecisionDomain,
  EmployeeId,
  OrgEvent,
  PositionId,
  SimTime,
} from '@maoeh/shared-types';
import type { Task, TaskStatus, TaskVerification } from '@maoeh/task-system';

export const WORKFLOW_INSTANCE_STATUSES = [
  'running',
  'blocked',
  'completed',
  'aborted',
] as const;

export type WorkflowInstanceStatus = (typeof WORKFLOW_INSTANCE_STATUSES)[number];

export const STEP_STATUSES = ['pending', 'active', 'done', 'rejected', 'skipped'] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export const STEP_KINDS = ['task', 'approval', 'review', 'meeting', 'automated'] as const;

export type StepKind = (typeof STEP_KINDS)[number];

export const CYCLE_POLICIES = ['forbid', 'allow'] as const;

export type CyclePolicy = (typeof CYCLE_POLICIES)[number];

export const APPROVAL_POLICIES = ['single', 'quorum', 'all'] as const;

export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const APPROVAL_STATUSES = ['open', 'granted', 'denied'] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * Where a step's task goes.
 *
 * `capability` is the form a template should use: the step declares *what kind of work* it is
 * and the live organization answers with a seat, exactly like a generated workflow does. Pin a
 * template to `position` and the workflow silently re-introduces routing by seat — which is how
 * a template came to hand its intake and delivery steps to the CEO, whatever the chart said.
 */
export type AssignmentRule =
  | { readonly kind: 'employee'; readonly employeeId: EmployeeId }
  | { readonly kind: 'position'; readonly positionId: PositionId }
  | { readonly kind: 'capability'; readonly capability: string }
  | { readonly kind: 'unassigned' };

export interface AuthorityRequirement {
  readonly domain: DecisionDomain;
  readonly level: AuthorityLevel;
}

export interface WorkflowStep {
  readonly stepId: string;
  readonly name: string;
  readonly kind: StepKind;
  readonly description: string | null;
  readonly assignment: AssignmentRule | null;
  /**
   * The *kind of work* this step declares, when it has one — the generated workflows set it from
   * the capability the stage was built for, and a capability-assigned template step carries it
   * by definition.
   *
   * It is not a second routing rule (the assignment already routed the work); it is what the
   * step hands to the executor's task, so the delivered work product can be shaped by what the
   * step *is* instead of by whatever tags the seat that happened to hold it carries. Optional
   * because steps written before this existed simply do not declare one.
   */
  readonly capability?: string | null;
  readonly verification: TaskVerification | null;
  readonly maxAttempts: number;
  readonly requiredAuthority: AuthorityRequirement | null;
  readonly requiredRoles: readonly string[];
  readonly approvalPolicy: ApprovalPolicy;
  readonly requiredCount: number;
}

export type TransitionCondition =
  | { readonly kind: 'always' }
  | {
      readonly kind: 'task_status';
      readonly status: 'completed' | 'rejected' | 'failed';
    }
  | { readonly kind: 'approval_decision'; readonly decision: 'granted' | 'denied' };

export type TransitionTarget =
  | { readonly kind: 'step'; readonly stageId: string | null; readonly stepId: string }
  | { readonly kind: 'stage'; readonly stageId: string }
  | { readonly kind: 'complete' }
  | { readonly kind: 'fail'; readonly reason: string | null };

export interface WorkflowTransition {
  readonly transitionId: string;
  readonly fromStepId: string;
  readonly when: TransitionCondition;
  readonly to: TransitionTarget;
}

export interface WorkflowStage {
  readonly stageId: string;
  readonly name: string;
  readonly steps: readonly WorkflowStep[];
  readonly transitions: readonly WorkflowTransition[];
}

export interface WorkflowDefinition {
  readonly workflowId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string | null;
  readonly cyclePolicy: CyclePolicy;
  readonly entryStageId: string;
  readonly terminalStageIds: readonly string[];
  readonly stages: readonly WorkflowStage[];
}

export interface StepState {
  readonly stepId: string;
  readonly status: StepStatus;
  readonly enteredAtSim: SimTime | null;
  readonly completedAtSim: SimTime | null;
  readonly outcome: string | null;
  readonly taskId: string | null;
}

export interface WorkflowApproval {
  readonly approvalKey: string;
  readonly stepId: string;
  readonly status: ApprovalStatus;
  readonly policy: ApprovalPolicy;
  readonly requiredCount: number;
  readonly requiredLevel: AuthorityLevel;
  readonly requiredRoles: readonly string[];
  readonly requestedBy: string;
  readonly requestedAtSim: SimTime;
  readonly grantedBy: readonly string[];
  readonly decidedBy: string | null;
  readonly decidedAtSim: SimTime | null;
  readonly reason: string | null;
}

export interface WorkflowBlockedReason {
  readonly kind: 'approval' | 'manual' | 'task';
  readonly detail: string;
  readonly stepId: string | null;
}

export interface WorkflowInstance {
  readonly instanceId: string;
  readonly companyId: string;
  readonly workflowId: string;
  readonly version: number;
  readonly title: string;
  readonly goal: string;
  readonly status: WorkflowInstanceStatus;
  readonly currentStageId: string | null;
  readonly activeStepIds: readonly string[];
  readonly stepStates: Readonly<Record<string, StepState>>;
  readonly context: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly initiatedBy: string;
  readonly correlationId: string;
  readonly startedAtSim: SimTime;
  readonly completedAtSim: SimTime | null;
  readonly abortedAtSim: SimTime | null;
  readonly blockedReason: WorkflowBlockedReason | null;
  readonly approval: WorkflowApproval | null;
  readonly sourceEventId: string;
  readonly processedEventIds: readonly string[];
}

export type WorkflowOutcome =
  | 'transitioned'
  | 'completed'
  | 'aborted'
  /** The instance was removed rather than stopped: there is no record left to report on. */
  | 'deleted'
  | 'retried'
  | 'awaiting_approval'
  | 'verification_pending'
  | 'paused'
  | 'resumed'
  | 'ignored'
  | 'duplicate';

export const APPROVAL_LIKE_STEP_KINDS: readonly StepKind[] = [
  'approval',
  'review',
  'meeting',
];

export function isApprovalLike(kind: StepKind): boolean {
  return APPROVAL_LIKE_STEP_KINDS.includes(kind);
}

export function findStage(
  definition: WorkflowDefinition,
  stageId: string,
): WorkflowStage | null {
  return definition.stages.find((stage) => stage.stageId === stageId) ?? null;
}

export function findStep(
  definition: WorkflowDefinition,
  stepId: string,
): { readonly stage: WorkflowStage; readonly step: WorkflowStep } | null {
  for (const stage of definition.stages) {
    const step = stage.steps.find((candidate) => candidate.stepId === stepId);
    if (step !== undefined) return { stage, step };
  }
  return null;
}

export function allTransitions(
  definition: WorkflowDefinition,
): readonly WorkflowTransition[] {
  return definition.stages.flatMap((stage) => stage.transitions);
}

export function withoutBookkeeping(
  instance: WorkflowInstance,
): Omit<WorkflowInstance, 'processedEventIds'> {
  const rest = { ...instance } as unknown as Record<string, unknown>;
  delete rest['processedEventIds'];
  return rest as unknown as Omit<WorkflowInstance, 'processedEventIds'>;
}

export type TaskStatusInput = Extract<TaskStatus, 'completed' | 'rejected'>;

export interface WorkflowOperation {
  readonly instance: WorkflowInstance;
  readonly events: readonly OrgEvent[];
  readonly outcome: WorkflowOutcome;
  readonly task?: Task;
}
