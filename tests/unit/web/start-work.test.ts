import { describe, expect, it } from 'vitest';
import { parseCommandOutcome, type Row } from '../../../apps/web/src/api';
import { submitWorkBrief, type CommandContext } from '../../../apps/web/src/commands';
import {
  briefItemViews,
  briefSubmission,
  openGate,
  submissionStatus,
  workflowsForCommand,
} from '../../../apps/web/src/derive';

/**
 * The "发起公司任务书 → 开始工作" chain has two seams that decide whether the operator ever sees
 * an answer, and both are pinned here because neither can be seen from a screenshot:
 *
 * - the command the button builds, which must still be exactly what the Control Plane accepts
 *   (a payload the API refuses would be reported as a failure, not as work);
 * - the read-back that turns the accepted command into the block under the button — the brief
 *   (found by the operator's own `commandId`), the work items with their `taskId`s, and the gate
 *   the organization is waiting on. A submission whose record has not arrived must read as
 *   "accepted, reading back" — never as an empty success, and never as nothing at all.
 */

const ctx: CommandContext = { companyId: 'peter-ai-lab', simTime: 46215 };

const item = (taskId: string, status: string): Row => ({
  taskId,
  title: `brief — ${taskId}`,
  goal: 'goal',
  status,
  positionId: 'agent-engineer',
  assigneeEmployeeId: 'ines',
});

const briefRow = (commandId: string, items: readonly Row[] = []): Row => ({
  briefId: 'brief-1',
  commandId,
  agentId: 'ceo-alex',
  operatorId: 'ceo-alex',
  reason: 'diagnostic run',
  correlationId: commandId,
  title: 'DIAG 开始工作链路自检',
  goal: 'prove the chain',
  context: null,
  verificationKeys: ['diag-key'],
  priority: null,
  dueAtSim: null,
  submittedAtSim: 46215,
  items,
  counts: { total: items.length, assigned: items.length, completed: 0, blocked: 0, rejected: 0 },
});

const workflowRow = (correlationId: string, approvalStatus: string): Row => ({
  instanceId: 'instance-7',
  workflowId: 'generated-instance-7',
  title: 'DIAG 开始工作链路自检',
  status: 'running',
  stageId: 'stage-approve',
  correlationId,
  approval: { stepId: 'step-approve', status: approvalStatus, requiredCount: 1, grantedBy: [] },
});

describe('work brief command', () => {
  it('addresses the Chief Officer and carries the brief the Control Plane validates', () => {
    const command = submitWorkBrief(ctx, 'ceo-alex', {
      title: 'Ship the changelog',
      goal: 'Publish it',
      context: '',
      verificationKeys: ['changelog.md'],
    }, 'Quarterly release');
    expect(command.commandType).toBe('Work.SubmitBrief');
    expect(command.target).toEqual({ targetType: 'agent', targetId: 'ceo-alex' });
    expect(command.reason).toBe('Quarterly release');
    expect(typeof command.commandId).toBe('string');
    expect(command.correlationId).toBe(command.commandId);
    expect(command.createdAtSim).toBe(46215);
    // `workBrief` is the exact shape `validation.ts` reads, and an empty context stays out of it.
    expect(command.workBrief).toEqual({
      title: 'Ship the changelog',
      goal: 'Publish it',
      verificationKeys: ['changelog.md'],
    });
  });

  it('keeps the operator reason on the envelope, so a refusal is auditable too', () => {
    const command = submitWorkBrief(ctx, 'ceo-alex', { title: 't', goal: 'g', context: 'c', verificationKeys: ['k'] }, 'because');
    expect((command.workBrief as Row)['context']).toBe('c');
    expect(command.reason).toBe('because');
  });

  it('reports the Control Plane refusal verbatim instead of inventing a success', () => {
    const outcome = parseCommandOutcome({
      status: 'rejected',
      commandId: 'ui-1',
      commandType: 'Work.SubmitBrief',
      replayed: false,
      events: [],
      auditId: 'audit-1',
      failure: { code: 'UNAUTHORIZED', issues: [{ field: 'agentId', reason: 'agent "ceo-alex" is archived' }] },
    });
    expect(outcome.status).toBe('rejected');
    expect(outcome.failure).toBe('UNAUTHORIZED — agentId: agent "ceo-alex" is archived');
  });
});

describe('submission read-back', () => {
  it('finds only the brief the operator filed, and none before the read model answers', () => {
    const briefs = [briefRow('someone-else'), briefRow('ui-1')];
    expect(briefSubmission(briefs, [], 'ui-1').brief?.['briefId']).toBe('brief-1');
    expect(briefSubmission(briefs, [], 'ui-2').brief).toBeNull();
    expect(briefSubmission(briefs, [], '').brief).toBeNull();
  });

  it('exposes every work item with the taskId the Tasks page addresses', () => {
    const items = briefItemViews(briefRow('ui-1', [item('task-10', 'assigned'), item('task-11', 'completed')]));
    expect(items.map((entry) => entry.taskId)).toEqual(['task-10', 'task-11']);
    expect(items[0]?.positionId).toBe('agent-engineer');
    expect(briefItemViews(null)).toEqual([]);
  });

  it('links the workflow and its open gate through the command correlation', () => {
    const workflows = [workflowRow('other', 'open'), workflowRow('ui-1', 'granted')];
    expect(workflowsForCommand(workflows, 'ui-1').map((row) => row['instanceId'])).toEqual(['instance-7']);
    expect(openGate(workflowsForCommand(workflows, 'ui-1'))).toBeNull();
    expect(openGate(workflowsForCommand(workflows, 'other'))?.['instanceId']).toBe('instance-7');
    expect(workflowsForCommand(workflows, '')).toEqual([]);
  });
});

describe('submission status', () => {
  const status = (
    stage: 'creating' | 'failed' | 'filed',
    briefs: readonly Row[],
    workflows: readonly Row[] = [],
    held = false,
    paused = false,
    gate: Row | null = null,
  ) => submissionStatus({ stage, submission: briefSubmission(briefs, workflows, 'ui-1'), held, paused, gate });

  it('acknowledges the click before any round trip, and names a refusal when one happened', () => {
    expect(status('creating', []).stage).toBe('creating');
    expect(status('failed', []).stage).toBe('failed');
  });

  it('says "accepted, reading back" until the brief exists — never "created"', () => {
    const filed = status('filed', []);
    expect(filed.stage).toBe('filed');
    expect(filed.tone).toBe('idle');
  });

  it('reports the breakdown as pending while the brief still has no work item', () => {
    expect(status('filed', [briefRow('ui-1')]).stage).toBe('decomposing');
  });

  it('prefers the open gate over the hold: that is the decision the operator owes', () => {
    const briefs = [briefRow('ui-1', [item('task-10', 'assigned')])];
    const gate = workflowRow('ui-1', 'open');
    expect(status('filed', briefs, [gate], true, false, gate).stage).toBe('approval');
    // A gate the hold is protecting is a decision too, even when the brief started no workflow.
    expect(status('filed', briefs, [], true, false, workflowRow('elsewhere', 'open')).stage).toBe('approval');
  });

  it('shows a held runtime as paused work rather than an ordinary running task', () => {
    const briefs = [briefRow('ui-1', [item('task-10', 'assigned')])];
    expect(status('filed', briefs, [], true).stage).toBe('held');
    expect(status('filed', briefs, [], false, true).stage).toBe('held');
    expect(status('filed', briefs, [], false, false).stage).toBe('running');
  });

  it('counts a finished decomposition as completed', () => {
    const briefs = [briefRow('ui-1', [item('task-10', 'completed'), item('task-11', 'completed')])];
    expect(status('filed', briefs, [], true).stage).toBe('completed');
  });
});
