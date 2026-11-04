import type { ActorContext, OrgEvent, Result, SimTime } from '@maoeh/shared-types';
import type { AgentDefinition } from '@maoeh/agent-definition';
import type { CognitionError } from '../cognition-errors.js';
import { cognitionIssue } from '../cognition-errors.js';
import type { CognitionProfile } from '../profile.js';
import type {
  CognitionAgentRef,
  CognitionContext,
  CognitionStateView,
  OrganizationSnapshotView,
  WorkCatalogView,
} from './cognition-context.js';

export interface BuildCognitionContextInput {
  readonly agent: CognitionAgentRef;
  readonly definition: AgentDefinition;
  readonly actorContext: ActorContext | undefined;
  readonly state: CognitionStateView | undefined;
  readonly inputEvent: OrgEvent | undefined;
  readonly organization: OrganizationSnapshotView | undefined;
  readonly simTime: SimTime;
  readonly profile: CognitionProfile | undefined;
  readonly workCatalog?: WorkCatalogView;
  readonly memoryContext?: Readonly<Record<string, unknown>>;
  readonly knowledgeContext?: Readonly<Record<string, unknown>>;
}

export function buildCognitionContext(
  input: BuildCognitionContextInput,
): Result<CognitionContext, CognitionError> {
  const { agent, definition, actorContext, state, inputEvent, organization, profile } = input;

  if (actorContext === undefined || actorContext === null) {
    return {
      ok: false,
      error: cognitionIssue(
        'missing_actor_context',
        'actorContext',
        'a CognitionContext cannot be built without an ActorContext (A4)',
      ),
    };
  }
  if (agent.employeeId === '') {
    return {
      ok: false,
      error: cognitionIssue('invalid_context', 'agent.employeeId', 'employeeId must not be empty'),
    };
  }
  if (definition.id === '') {
    return {
      ok: false,
      error: cognitionIssue('invalid_context', 'definition.id', 'definition id must not be empty'),
    };
  }
  if (definition.employeeId !== agent.employeeId) {
    return {
      ok: false,
      error: cognitionIssue(
        'invalid_context',
        'definition.employeeId',
        `definition belongs to "${definition.employeeId}" but agent is "${agent.employeeId}"`,
      ),
    };
  }
  if (actorContext.employeeId !== agent.employeeId) {
    return {
      ok: false,
      error: cognitionIssue(
        'invalid_context',
        'actorContext.employeeId',
        `actor is "${actorContext.employeeId}" but agent is "${agent.employeeId}"`,
      ),
    };
  }
  if (state === undefined || state === null) {
    return {
      ok: false,
      error: cognitionIssue('invalid_context', 'state', 'AgentState is required'),
    };
  }
  if (state.employeeId !== agent.employeeId) {
    return {
      ok: false,
      error: cognitionIssue(
        'invalid_context',
        'state.employeeId',
        `state belongs to "${state.employeeId}" but agent is "${agent.employeeId}"`,
      ),
    };
  }
  if (inputEvent === undefined || inputEvent === null) {
    return {
      ok: false,
      error: cognitionIssue('invalid_context', 'inputEvent', 'input event is required'),
    };
  }
  if (organization === undefined || organization === null) {
    return {
      ok: false,
      error: cognitionIssue('invalid_context', 'organization', 'organization snapshot is required'),
    };
  }
  if (profile === undefined || profile === null || profile.id === '') {
    return {
      ok: false,
      error: cognitionIssue('invalid_profile', 'profile.id', 'cognition profile is required'),
    };
  }

  const context: CognitionContext = {
    agent,
    definition,
    actorContext,
    state,
    inputEvent,
    organization,
    simTime: input.simTime,
    ...(input.workCatalog === undefined ? {} : { workCatalog: input.workCatalog }),
    ...(input.memoryContext === undefined ? {} : { memoryContext: input.memoryContext }),
    ...(input.knowledgeContext === undefined ? {} : { knowledgeContext: input.knowledgeContext }),
  };

  return { ok: true, value: Object.freeze(context) };
}
