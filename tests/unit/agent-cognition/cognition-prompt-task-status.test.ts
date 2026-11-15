import { describe, expect, it } from 'vitest';
import { allowedTaskCommands } from '@maoeh/task-system';
import { buildCognitionPrompt } from '../../../packages/agent-cognition/src/prompts/cognition';
import { testContext, testStateView } from '../../helpers/cognition-fixtures';

/**
 * The task state machine, rendered into the prompt.
 *
 * A live run (`.maoeh/audit/collaboration/run-2026-11-14T10-55-01-735Z`) showed the exact failure
 * this covers: the CTO accepted a task, messaged a colleague, received the answer — and then tried
 * `SubmitReport` from `accepted`, which the task system refuses (`invalid_transition`). It retried
 * four times and the deliverable never landed. The machine was never wrong; the planner simply
 * could not see it.
 *
 * The legal set is passed in from `task-system` (cognition does not import it), so these tests pin
 * both halves: the machine's own answer, and the prompt actually rendering it.
 */
describe('task state machine: the legal commands of a status', () => {
  it('is the machine the task service enforces', () => {
    // M3.1: `handoff` is legal while the work is open — an accepted task can still be transferred
    // to a named colleague, which is the whole point of a handoff before execution finishes.
    expect(allowedTaskCommands('accepted')).toEqual(['start', 'reject', 'handoff', 'cancel']);
    expect(allowedTaskCommands('started')).toContain('submit');
    expect(allowedTaskCommands('started')).toContain('handoff');
    expect(allowedTaskCommands('completed')).toEqual([]);
    // A submitted task waits for settlement; transferring it would move work nobody can verify.
    expect(allowedTaskCommands('submitted')).not.toContain('handoff');
  });
});

describe('cognition prompt: a task the agent owns must show what it may do next', () => {
  const acceptedTask = {
    taskId: 'task-1',
    title: '登录页会话方案（技术设计）',
    goal: 'Produce the technical design.',
    status: 'accepted',
    allowedCommands: ['start', 'reject', 'cancel'],
  };

  it('renders the legal commands beside the task', () => {
    const prompt = buildCognitionPrompt(
      testContext({ state: testStateView({ assignedTasks: [acceptedTask] }) }),
    );
    expect(prompt).toContain('taskId=task-1');
    expect(prompt).toContain('legal commands in this status: start, reject, cancel');
    expect(prompt).toContain('invalid_transition');
    expect(prompt).toContain('StartTask');
  });

  it('does not invent a commands line when the runtime supplied none', () => {
    const prompt = buildCognitionPrompt(
      testContext({
        state: testStateView({
          assignedTasks: [
            {
              taskId: acceptedTask.taskId,
              title: acceptedTask.title,
              goal: acceptedTask.goal,
              status: acceptedTask.status,
            },
          ],
        }),
      }),
    );
    expect(prompt).toContain('taskId=task-1');
    expect(prompt).not.toContain('legal commands in this status');
  });
});
