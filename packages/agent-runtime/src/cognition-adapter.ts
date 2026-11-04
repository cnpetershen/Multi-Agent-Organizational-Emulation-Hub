import type {
  ActorContext,
  OrgEvent,
  Result,
  SimTime,
} from '@maoeh/shared-types';
import type { AgentDefinition } from '@maoeh/agent-definition';
import type {
  CognitionContext,
  CognitionError,
  CognitionExecutor,
  CognitionProfile,
  CognitionRequest,
  CognitionResult,
  CognitionStateView,
  OrganizationSnapshotView,
  WorkCatalogView,
} from '@maoeh/agent-cognition';
import { buildCognitionContext } from '@maoeh/agent-cognition';
import type { AgentState } from '@maoeh/runtime-state';
import type { AgentInstance } from './agent-instance.js';

export interface AgentCognitionInput {
  readonly executor: CognitionExecutor;
  readonly requestId: string;
  readonly instance: Pick<AgentInstance, 'id' | 'definitionId' | 'employeeId' | 'state'>;
  readonly definition: AgentDefinition;
  readonly actorContext: ActorContext;
  readonly profile: CognitionProfile;
  readonly organization: OrganizationSnapshotView;
  readonly inputEvent: OrgEvent;
  readonly simTime: SimTime;
  readonly maxLlmCalls: number;
  readonly traceId?: string | null;
  readonly workCatalog?: WorkCatalogView;
  readonly memoryContext?: Readonly<Record<string, unknown>>;
  readonly knowledgeContext?: Readonly<Record<string, unknown>>;
}

export interface RuntimeCognitionOutcome {
  readonly cognition: CognitionResult;
  readonly stateVersionBefore: number;
}

export function toCognitionStateView(state: AgentState): CognitionStateView {
  return {
    employeeId: state.employeeId,
    version: state.version,
    employment: state.employment,
    presence: state.presence,
    currentCycleId: state.currentCycleId,
    agenda: state.agenda,
    updatedAtSim: state.updatedAtSim,
  };
}

function buildContext(input: AgentCognitionInput): Result<CognitionContext, CognitionError> {
  const { instance, definition, actorContext, organization, inputEvent, profile } = input;
  return buildCognitionContext({
    agent: {
      id: instance.id,
      definitionId: instance.definitionId,
      employeeId: instance.employeeId,
    },
    definition,
    actorContext,
    state: toCognitionStateView(instance.state),
    inputEvent,
    organization,
    simTime: input.simTime,
    profile,
    ...(input.workCatalog === undefined ? {} : { workCatalog: input.workCatalog }),
    ...(input.memoryContext === undefined ? {} : { memoryContext: input.memoryContext }),
    ...(input.knowledgeContext === undefined ? {} : { knowledgeContext: input.knowledgeContext }),
  });
}

export async function runAgentCognition(
  input: AgentCognitionInput,
): Promise<Result<RuntimeCognitionOutcome, CognitionError>> {
  const contextResult = buildContext(input);
  if (!contextResult.ok) return { ok: false, error: contextResult.error };

  const request: CognitionRequest = {
    requestId: input.requestId,
    actorContext: input.actorContext,
    cognitionContext: contextResult.value,
    profile: input.profile,
    maxLlmCalls: input.maxLlmCalls,
    simTime: input.simTime,
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  };

  const cognitionResult = await input.executor.execute(request);
  if (!cognitionResult.ok) return cognitionResult;

  return {
    ok: true,
    value: {
      cognition: cognitionResult.value,
      stateVersionBefore: input.instance.state.version,
    },
  };
}
