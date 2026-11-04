export const AUDIT_VERDICTS = ['accepted', 'rejected', 'failed'] as const;

export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

export const AUDIT_ACTOR_KINDS = ['employee', 'human', 'system'] as const;

export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export interface AuditAction {
  readonly type: string;
  readonly reason: string;
  readonly resource: string;
}

export interface AuditTarget {
  readonly targetType: string;
  readonly targetId: string;
}

export interface AuditRecord {
  readonly auditId: string;
  readonly actorKind: AuditActorKind;
  readonly actorId: string | null;
  readonly action: AuditAction;
  readonly target: AuditTarget;
  readonly verdict: AuditVerdict;
  readonly commandId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly resultCode: string | null;
  readonly eventIds: readonly string[];
  readonly createdAtSim: number;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface AuditQuery {
  readonly actorId?: string;
  readonly commandId?: string;
  readonly targetId?: string;
  readonly correlationId?: string;
  readonly verdict?: AuditVerdict;
  readonly limit?: number;
}

export interface AuditStore {
  append(record: AuditRecord): void;
  byCommandId(commandId: string): AuditRecord | null;
  byTarget(targetId: string): readonly AuditRecord[];
  byCorrelationId(correlationId: string): readonly AuditRecord[];
  all(): readonly AuditRecord[];
  query(q: AuditQuery): readonly AuditRecord[];
  size(): number;
}
