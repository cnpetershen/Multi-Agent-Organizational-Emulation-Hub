import type { WorkflowDefinition } from './workflow-types.js';
import { assertValidWorkflowDefinition } from './workflow-validation.js';

/**
 * A4 (`docs/review/role-agents-cannot-complete-tasks.md` §9): a `RecommendHire` never fills a
 * seat by itself. The kernel opens this gate instead — the request, the original objectives and
 * the deferred workflow proposal live on the instance context while the root approval chain
 * (`requiredRoles` below) decides, and the roster only moves after a grant.
 *
 * The gate is deliberately approval-only: no task step, nothing for an agent to execute. The
 * kernel's deterministic pass (`runHiringGatePhase` in the runtime) is what consumes the
 * decision — materializing the employee on a grant, re-routing the deferred proposal, and
 * surfacing a human-decision block on a denial.
 */
export const HIRING_WORKFLOW_ID = 'hire-gate';

const HIRE_STAGE_ID = 'stage-hire';
const HIRE_STEP_ID = 'step-hire-approval';

/**
 * Roles that may decide the gate: the CEO seat (the production console acts as the CEO) and the
 * board operator seat (the test/operator-seed root). `requiredAuthority` stays null on purpose —
 * giving the CEO org-level authority would let the agent approve its own request the moment the
 * gate woke it, and the whole point is that a human decides while the roster stands still.
 */
const HIRING_APPROVAL_ROLES: readonly string[] = ['ceo', 'board-operator'];

export const HIRING_WORKFLOW_DEFINITION: WorkflowDefinition = {
  workflowId: HIRING_WORKFLOW_ID,
  version: 1,
  name: 'Hiring request (root approval)',
  description:
    'Fills an existing seat only after the root approval chain grants the request; the original objectives stay blocked and recoverable while the decision is open.',
  cyclePolicy: 'forbid',
  entryStageId: HIRE_STAGE_ID,
  terminalStageIds: [HIRE_STAGE_ID],
  stages: [
    {
      stageId: HIRE_STAGE_ID,
      name: 'Root approval',
      steps: [
        {
          stepId: HIRE_STEP_ID,
          name: 'Approve the hiring request',
          kind: 'approval',
          description: null,
          assignment: null,
          verification: null,
          maxAttempts: 1,
          requiredAuthority: null,
          requiredRoles: [...HIRING_APPROVAL_ROLES],
          approvalPolicy: 'single',
          requiredCount: 1,
        },
      ],
      transitions: [
        {
          transitionId: `${HIRE_STAGE_ID}__granted`,
          fromStepId: HIRE_STEP_ID,
          when: { kind: 'approval_decision', decision: 'granted' },
          to: { kind: 'complete' },
        },
        {
          transitionId: `${HIRE_STAGE_ID}__denied`,
          fromStepId: HIRE_STEP_ID,
          when: { kind: 'approval_decision', decision: 'denied' },
          to: { kind: 'fail', reason: 'approval_denied' },
        },
      ],
    },
  ],
};

const validated = assertValidWorkflowDefinition(HIRING_WORKFLOW_DEFINITION);
if (!validated.ok) {
  throw new Error(
    `hiring workflow definition is invalid: ${validated.error.issues
      .map((issue) => `${issue.field}: ${issue.reason}`)
      .join(', ')}`,
  );
}
