import type {
  ActorContext,
  CompanyId,
  CorrelationId,
  EmployeeId,
  OrgEvent,
  Result,
  SimTime,
} from '@maoeh/shared-types';
import type { EventContractFailure, EventRegistry } from '@maoeh/event-system';
import { createOrgEvent } from '@maoeh/event-system';
import type { AuthzService } from '@maoeh/permission-system';
import { channelResource } from '@maoeh/permission-system';
import type { CommunicationFailure } from '../communication-errors.js';
import {
  communicationFailure,
  failure,
  permissionFailure,
} from '../communication-errors.js';
import { unknownActor, validateActorContext } from '../authorization/actor-context.js';
import type { CommunicationIdentity } from '../identity/communication-identity.js';
import {
  COMMUNICATION_COLLABORATION_REQUESTED,
  collaborationRequestedPayloadSchema,
  registerCommunicationEvents,
} from '../events/communication-events.js';
import { collaborationRequestDraftSchema } from './collaboration-validation.js';
import { zodIssues } from '../validation/zod-issues.js';

/**
 * A collaboration request is agent-to-agent communication ("please help me with this task"),
 * recorded on the log so a human can see who asked whom, and for what, without reading the
 * message stream. It carries no delivery semantics of its own: the runtime simply wakes the
 * requested agent, exactly as it wakes a message recipient.
 */
export const COLLABORATION_RESOURCE_ID = 'collaboration';

/**
 * Collaboration is authorized under the existing `SendMessage` action on a `channel:*` resource:
 * asking an agent for help is asking that agent for something, and the kernel's default policy
 * already grants every employee the right to do that.
 */
export const COLLABORATION_ACTION = 'SendMessage';

export interface CollaborationRecord {
  readonly collaborationId: string;
  readonly fromAgentId: EmployeeId;
  readonly toAgentId: EmployeeId;
  readonly taskId: string;
  readonly purpose: string;
  readonly requestedAtSim: SimTime;
  readonly sourceEventId: string;
}

export interface CreateCollaborationRecordInput {
  readonly collaborationId: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly taskId: string;
  readonly purpose: string;
  readonly requestedAtSim: SimTime;
  readonly sourceEventId: string;
}

export function createCollaborationRecord(
  input: CreateCollaborationRecordInput,
): CollaborationRecord {
  return Object.freeze({
    collaborationId: input.collaborationId,
    fromAgentId: input.fromAgentId as EmployeeId,
    toAgentId: input.toAgentId as EmployeeId,
    taskId: input.taskId,
    purpose: input.purpose,
    requestedAtSim: input.requestedAtSim,
    sourceEventId: input.sourceEventId,
  });
}

export interface CollaborationStore {
  get(collaborationId: string): CollaborationRecord | null;
  save(collaboration: CollaborationRecord): void;
  all(): readonly CollaborationRecord[];
}

export function createInMemoryCollaborationStore(): CollaborationStore {
  const collaborations = new Map<string, CollaborationRecord>();
  return {
    get(collaborationId) {
      return collaborations.get(collaborationId) ?? null;
    },
    save(collaboration) {
      collaborations.set(collaboration.collaborationId, collaboration);
    },
    all() {
      return Object.freeze([...collaborations.values()]);
    },
  };
}

export interface RequestCollaborationInput {
  readonly actor: ActorContext;
  readonly fromAgentId: EmployeeId;
  readonly toAgentId: EmployeeId;
  readonly taskId: string;
  readonly purpose: string;
  readonly simTime: SimTime;
  readonly correlationId?: CorrelationId;
  readonly causationId?: string | null;
  readonly traceId?: string | null;
}

export interface RequestCollaborationResult {
  readonly collaboration: CollaborationRecord;
  readonly event: OrgEvent;
}

export interface CollaborationServiceDeps {
  readonly authz: AuthzService;
  readonly identity: CommunicationIdentity;
  readonly registry: EventRegistry;
  readonly store: CollaborationStore;
  readonly companyId: CompanyId;
}

export interface CollaborationServiceOptions {
  readonly collaborationIdGenerator?: () => string;
  readonly eventIdGenerator?: () => string;
}

export interface CollaborationService {
  requestCollaboration(
    input: RequestCollaborationInput,
  ): Result<RequestCollaborationResult, CommunicationFailure>;
  getCollaboration(collaborationId: string): CollaborationRecord | null;
  getCollaborations(): readonly CollaborationRecord[];
}

function eventFailure(failureValue: EventContractFailure): CommunicationFailure {
  return communicationFailure(
    'event_contract_violation',
    failureValue.issues.map((eventIssue) => ({
      field: eventIssue.field,
      reason: eventIssue.reason,
    })),
  );
}

export function createCollaborationService(
  deps: CollaborationServiceDeps,
  options?: CollaborationServiceOptions,
): CollaborationService {
  registerCommunicationEvents(deps.registry);

  let collaborationCounter = 0;
  let eventCounter = 0;
  const nextCollaborationId =
    options?.collaborationIdGenerator ?? (() => `collab-${String((collaborationCounter += 1))}`);
  const nextEventId = options?.eventIdGenerator ?? (() => `evt-${String((eventCounter += 1))}`);

  const request = (
    input: RequestCollaborationInput,
  ): Result<RequestCollaborationResult, CommunicationFailure> => {
    const actorFailure = validateActorContext(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };
    if (input.actor.employeeId !== input.fromAgentId) {
      return {
        ok: false,
        error: failure(
          'sender_mismatch',
          'fromAgentId',
          `actor "${input.actor.employeeId}" cannot request collaboration as "${input.fromAgentId}"`,
        ),
      };
    }

    const draft = collaborationRequestDraftSchema.safeParse({
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      taskId: input.taskId,
      purpose: input.purpose,
    });
    if (!draft.success) {
      return {
        ok: false,
        error: communicationFailure('invalid_collaboration', zodIssues(draft.error)),
      };
    }

    const requester = deps.identity.resolve(input.fromAgentId);
    if (!requester.ok) return { ok: false, error: unknownActor(String(input.fromAgentId)) };
    const requested = deps.identity.resolve(input.toAgentId);
    if (!requested.ok) {
      return {
        ok: false,
        error: failure(
          'invalid_recipient',
          'toAgentId',
          `identity system cannot resolve employee "${input.toAgentId}"`,
        ),
      };
    }

    const decision = deps.authz.can(
      input.actor,
      COLLABORATION_ACTION,
      channelResource(COLLABORATION_RESOURCE_ID),
    );
    if (!decision.allow) {
      return { ok: false, error: permissionFailure(COLLABORATION_ACTION, decision) };
    }

    const collaborationId = nextCollaborationId();
    const created = createOrgEvent(
      deps.registry,
      {
        companyId: deps.companyId,
        type: COMMUNICATION_COLLABORATION_REQUESTED,
        occurredAtSim: input.simTime,
        actorKind: 'employee',
        actorId: String(input.actor.employeeId),
        subjectType: 'employee',
        subjectId: String(input.fromAgentId),
        correlationId: input.correlationId ?? input.actor.correlationId,
        causationId: input.causationId ?? null,
        traceId: input.traceId ?? null,
        payload: {
          collaborationId,
          fromAgentId: String(input.fromAgentId),
          toAgentId: String(input.toAgentId),
          taskId: input.taskId,
          purpose: draft.data.purpose,
        },
        eventId: nextEventId(),
      },
    );
    if (!created.ok) return { ok: false, error: eventFailure(created.error) };

    const collaboration = createCollaborationRecord({
      collaborationId,
      fromAgentId: String(input.fromAgentId),
      toAgentId: String(input.toAgentId),
      taskId: input.taskId,
      purpose: draft.data.purpose,
      requestedAtSim: input.simTime,
      sourceEventId: created.value.eventId,
    });
    deps.store.save(collaboration);
    return { ok: true, value: { collaboration, event: created.value } };
  };

  return {
    requestCollaboration: request,
    getCollaboration(collaborationId) {
      return deps.store.get(collaborationId);
    },
    getCollaborations() {
      return deps.store.all();
    },
  };
}

/** Rebuild one collaboration record from its log event; used by kernel recovery. */
export function collaborationFromEvent(
  event: OrgEvent,
): Result<CollaborationRecord, CommunicationFailure> {
  const parsed = collaborationRequestedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: communicationFailure('invalid_collaboration', zodIssues(parsed.error)),
    };
  }
  return {
    ok: true,
    value: createCollaborationRecord({
      collaborationId: parsed.data.collaborationId,
      fromAgentId: parsed.data.fromAgentId,
      toAgentId: parsed.data.toAgentId,
      taskId: parsed.data.taskId,
      purpose: parsed.data.purpose,
      requestedAtSim: event.occurredAtSim,
      sourceEventId: event.eventId,
    }),
  };
}
