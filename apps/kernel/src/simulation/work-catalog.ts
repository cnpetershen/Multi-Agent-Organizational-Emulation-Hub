import type { ActorContext } from '@maoeh/shared-types';
import type { WorkCatalogView } from '@maoeh/agent-cognition';
import type { Organization } from '@maoeh/organization-model';
import type { AuthzService } from '@maoeh/permission-system';
import { resourceRef } from '@maoeh/permission-system';
import type { TaskService } from '@maoeh/task-system';
import { isTerminalStatus } from '@maoeh/task-system';
import type {
  WorkflowDefinitionStore,
  WorkflowInstanceStore,
} from '@maoeh/workflow-engine';

function workflowSummaries(
  definitions: WorkflowDefinitionStore,
): WorkCatalogView['workflows'] {
  return Object.freeze(
    definitions.all().map((definition) => {
      const steps = definition.stages.flatMap((stage) => stage.steps);
      return Object.freeze({
        workflowId: definition.workflowId,
        title: definition.name,
        goal: definition.description ?? definition.name,
        stepCount: steps.length,
        approvalGateCount: steps.filter((step) => step.kind === 'approval').length,
      });
    }),
  );
}

/**
 * Seats with their load: `openTaskCount` is what answers "who should this work go to", so it is
 * counted off live tasks rather than a cached projection, and terminal tasks never count as load.
 */
function positionSummaries(
  organization: Organization,
  tasks: TaskService,
): WorkCatalogView['positions'] {
  const openTasks = tasks.all().filter((task) => !isTerminalStatus(task.status));
  return Object.freeze(
    organization.positions.map((position) =>
      Object.freeze({
        positionId: position.id,
        title: position.title,
        departmentId: position.departmentId,
        authorityLevel: position.authorityLevel ?? 0,
        openTaskCount: openTasks.filter(
          (task) => task.assignment.positionId === position.id,
        ).length,
      }),
    ),
  );
}

/**
 * The pure-data catalog a planner needs to decompose a work brief (M1.4 §5.6): what the
 * organization can start, which seats exist and how loaded they are, what is already in flight,
 * and whether *this* actor's seat may dispatch at all. Read straight off the live stores so the
 * very next plan sees a seat (`Agent.Create`) or a settled workflow that just changed, and
 * `canDispatchWork` comes from the real policy instead of a prompt-side rule.
 */
export function workCatalogView(
  input: {
    readonly organization: Organization;
    readonly tasks: TaskService;
    readonly definitions: WorkflowDefinitionStore;
    readonly instances: WorkflowInstanceStore;
    readonly authz: AuthzService;
  },
  actorContext: ActorContext,
): WorkCatalogView {
  const inFlightWorkflows = input.instances
    .all()
    .filter((instance) => instance.status === 'running' || instance.status === 'blocked')
    .length;

  const canDispatchWork = input.authz.can(
    actorContext,
    'DispatchWork',
    resourceRef(`position:${actorContext.positionId}`),
  ).allow;

  return Object.freeze({
    workflows: workflowSummaries(input.definitions),
    positions: positionSummaries(input.organization, input.tasks),
    inFlightWorkflows,
    canDispatchWork,
  });
}
