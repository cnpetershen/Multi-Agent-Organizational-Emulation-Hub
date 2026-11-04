import type { ActorContext, Result, SimTime } from '@maoeh/shared-types';
import type { AgentDefinition } from '@maoeh/agent-definition';
import { createInitialAgentState } from '@maoeh/runtime-state';
import type { AgentInstantiateFailure, AgentInstantiateIssue, AgentInstance } from './agent-instance.js';

export function instantiateAgent(
  definition: AgentDefinition,
  context: ActorContext,
  createdAtSim: SimTime,
): Result<AgentInstance, AgentInstantiateFailure> {
  const issues: AgentInstantiateIssue[] = [];
  if (definition.employeeId !== context.employeeId) {
    issues.push({
      field: 'employeeId',
      reason: `definition is bound to "${definition.employeeId}" but actor context is "${context.employeeId}"`,
    });
  }
  if (definition.positionId !== context.positionId) {
    issues.push({
      field: 'positionId',
      reason: `definition position "${definition.positionId}" does not match actor context position "${context.positionId}"`,
    });
  }
  if ((definition.departmentId ?? null) !== context.departmentId) {
    issues.push({
      field: 'departmentId',
      reason: `definition department "${definition.departmentId ?? 'null'}" does not match actor context department "${context.departmentId ?? 'null'}"`,
    });
  }
  if (issues.length > 0) return { ok: false, error: { issues } };
  return {
    ok: true,
    value: {
      id: `agent:${definition.id}`,
      definitionId: definition.id,
      employeeId: definition.employeeId,
      state: createInitialAgentState(definition.employeeId),
      createdAtSim,
    },
  };
}
