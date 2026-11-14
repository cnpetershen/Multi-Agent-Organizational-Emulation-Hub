export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type CompanyId = Brand<string, 'CompanyId'>;
export type DepartmentId = Brand<string, 'DepartmentId'>;
export type PositionId = Brand<string, 'PositionId'>;
export type EmployeeId = Brand<string, 'EmployeeId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;
/** A human founder (M1.5). Identity only — never a credential. */
export type UserId = Brand<string, 'UserId'>;

export const DECISION_DOMAINS = [
  'engineering',
  'product',
  'ops',
  'marketing',
  'finance',
  'org',
] as const;

export type DecisionDomain = (typeof DECISION_DOMAINS)[number];

export type AuthorityLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface ActorContext {
  employeeId: EmployeeId;
  positionId: PositionId;
  departmentId: DepartmentId | null;
  authorityByDomain: Readonly<Record<DecisionDomain, AuthorityLevel>>;
  onBehalfOf?: EmployeeId;
  correlationId: CorrelationId;
}

export type SimTime = Brand<number, 'SimTime'>;

export type EventType = Brand<string, 'EventType'>;

export type ActorKind = 'employee' | 'human' | 'system';

export interface OrgEvent<T = unknown> {
  readonly seq: number;
  readonly eventId: string;
  readonly companyId: CompanyId;
  readonly type: EventType;
  readonly version: number;
  readonly occurredAtSim: SimTime;
  readonly occurredAtWall: string;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly payload: T;
  readonly causationId: string | null;
  readonly correlationId: string;
  readonly traceId: string | null;
}

export const EMPLOYMENT_STATUSES = [
  'defined',
  'onboarding',
  'active',
  'on_leave',
  'suspended',
  'transferred',
  'offboarded',
] as const;

export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const PRESENCE_STATES = [
  'idle',
  'perceiving',
  'thinking',
  'planning',
  'acting',
  'reflecting',
  'waiting_input',
  'blocked',
  'in_meeting',
  'faulted',
] as const;

export type PresenceState = (typeof PRESENCE_STATES)[number];

export type AgendaItem = Readonly<Record<string, unknown>>;

export const ACTIONS = [
  'SendMessage',
  'RequestCollaboration',
  'Reply',
  'Mention',
  'Announce',
  'SubmitReport',
  'AcceptTask',
  'RejectTask',
  'StartTask',
  'ProgressReport',
  'CompleteTask',
  'BlockTask',
  'ProduceArtifact',
  'CreateProposal',
  'DispatchWork',
  'ReviewProposal',
  'CastVote',
  'FinalizeDecision',
  'ApproveStep',
  'RejectStep',
  'DelegateApproval',
  'RequestMeeting',
  'Speak',
  'RequestDeviation',
  'Escalate',
  'RecommendHire',
  'RequestTransfer',
  'RequestPromotion',
  'RequestBudget',
  'ReadDocument',
  'Reflect',
  'PracticeSkill',
  'ScheduleSelf',
  'SetReminder',
  'DeferTask',
  'UpdatePresence',
  'InvokeTool',
  'channel.read',
  'message.read',
  'ControlSimulation',
  'ControlAgent',
  'ControlWorkflow',
  'ControlTask',
  'InjectOrganizationInput',
] as const;

export type Action = (typeof ACTIONS)[number];

export const CONTROL_ACTIONS = [
  'ControlSimulation',
  'ControlAgent',
  'ControlWorkflow',
  'ControlTask',
  'InjectOrganizationInput',
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export interface Step {
  readonly index: number;
  readonly action: Action;
  readonly args: Readonly<Record<string, unknown>>;
  readonly reasonRef: number;
  readonly doneWhen?: string;
  readonly idempotencyKey?: string;
}

export interface Plan {
  readonly goal: string;
  readonly steps: readonly Step[];
  readonly doneWhen: string;
}
