import type { CompanyId, EmployeeId, SimTime } from '@maoeh/shared-types';

export const WAKEUP_REASONS = [
  'EVENT',
  'SCHEDULE',
  'AGENDA',
  'TURN',
  'RETRY',
  'MANUAL',
] as const;

export type WakeupReason = (typeof WAKEUP_REASONS)[number];

export const WAKEUP_STATUSES = [
  'pending',
  'dispatched',
  'completed',
  'failed',
  'cancelled',
] as const;

export type WakeupStatus = (typeof WAKEUP_STATUSES)[number];

export const WAKEUP_TRIGGER_KINDS = [
  'event',
  'task',
  'workflow',
  'communication',
  'schedule',
  'agenda',
  'manual',
  'system',
] as const;

export type WakeupTriggerKind = (typeof WAKEUP_TRIGGER_KINDS)[number];

export interface WakeupTrigger {
  readonly kind: WakeupTriggerKind;
  readonly eventTypeId?: string | null;
  readonly refId?: string | null;
}

export interface AgentWakeup {
  readonly wakeupId: string;
  readonly companyId: CompanyId;
  readonly agentId: EmployeeId;
  readonly reason: WakeupReason;
  readonly trigger: WakeupTrigger;
  readonly sourceEventId: string | null;
  readonly scheduledAtSim: SimTime;
  readonly priority: number;
  readonly status: WakeupStatus;
  readonly mergedWakeupIds: readonly string[];
}

export const WAKEUP_PRIORITY = {
  system_recovery: 9,
  workflow: 8,
  task: 7,
  communication: 6,
  schedule: 5,
  agenda: 4,
  default: 5,
} as const;

export function priorityForTrigger(trigger: WakeupTrigger): number {
  switch (trigger.kind) {
    case 'workflow':
      return WAKEUP_PRIORITY.workflow;
    case 'task':
      return WAKEUP_PRIORITY.task;
    case 'communication':
      return WAKEUP_PRIORITY.communication;
    case 'schedule':
      return WAKEUP_PRIORITY.schedule;
    case 'agenda':
      return WAKEUP_PRIORITY.agenda;
    case 'system':
      return WAKEUP_PRIORITY.system_recovery;
    default:
      return WAKEUP_PRIORITY.default;
  }
}

export function compareWakeups(left: AgentWakeup, right: AgentWakeup): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.scheduledAtSim !== right.scheduledAtSim) {
    return left.scheduledAtSim - right.scheduledAtSim;
  }
  if (left.agentId !== right.agentId) return left.agentId < right.agentId ? -1 : 1;
  if (left.wakeupId !== right.wakeupId) return left.wakeupId < right.wakeupId ? -1 : 1;
  return 0;
}

export function wakeupKey(wakeup: AgentWakeup): string {
  return [
    wakeup.companyId,
    wakeup.agentId,
    wakeup.reason,
    wakeup.sourceEventId ?? '',
    String(wakeup.scheduledAtSim),
    wakeup.trigger.kind,
    wakeup.trigger.eventTypeId ?? '',
    wakeup.trigger.refId ?? '',
  ].join('|');
}

export function dedupeWakeups(wakeups: readonly AgentWakeup[]): readonly AgentWakeup[] {
  const merged = new Map<string, AgentWakeup>();
  const order: string[] = [];
  for (const wakeup of wakeups) {
    const key = wakeupKey(wakeup);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, wakeup);
      order.push(key);
      continue;
    }
    if (wakeup.wakeupId === existing.wakeupId) continue;
    merged.set(key, {
      ...existing,
      mergedWakeupIds: Object.freeze([
        ...existing.mergedWakeupIds,
        wakeup.wakeupId,
        ...wakeup.mergedWakeupIds,
      ]),
    });
  }
  return Object.freeze(order.map((key) => merged.get(key) as AgentWakeup).sort(compareWakeups));
}
