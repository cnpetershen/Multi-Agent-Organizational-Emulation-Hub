import { describe, expect, it } from 'vitest';
import { buildCognitionPrompt } from '../../../packages/agent-cognition/src/prompts/cognition';
import { testContext, testStateView } from '../../helpers/cognition-fixtures';

const taskOf = (status: string, allowedCommands?: readonly string[]) =>
  ({
    taskId: 'task-9',
    title: 'Ship the thing',
    goal: 'Produce the deliverable.',
    status,
    ...(allowedCommands === undefined ? {} : { allowedCommands }),
  });

describe('cognition prompt: the task execution protocol is explicit', () => {
  it('states the migration chain and the next-action directive', () => {
    const prompt = buildCognitionPrompt(
      testContext({ state: testStateView({ assignedTasks: [taskOf('accepted')] }) }),
    );
    expect(prompt).toContain('## Task execution protocol');
    expect(prompt).toContain('assigned');
    expect(prompt).toContain('AcceptTask');
    expect(prompt).toContain('StartTask');
    expect(prompt).toContain('SubmitReport');
    expect(prompt).toContain('next=<ACTION>');
    expect(prompt).toContain('"data": {...}');
    expect(prompt).toContain('real runnable file');
  });

  it('renders one next= directive per open task, matching its status', () => {
    const cases: readonly [string, string][] = [
      ['assigned', 'next=AcceptTask'],
      ['accepted', 'next=StartTask'],
      ['started', 'next=SubmitReport'],
      ['submitted', 'next=wait for review'],
    ];
    for (const [status, directive] of cases) {
      const prompt = buildCognitionPrompt(
        testContext({ state: testStateView({ assignedTasks: [taskOf(status)] }) }),
      );
      expect(prompt).toContain(`taskId=task-9`);
      expect(prompt).toContain(`status=${status}`);
      expect(prompt).toContain(directive);
    }
  });

  it('renders the confirmed workflow context for a downstream step', () => {
    const prompt = buildCognitionPrompt(
      testContext({
        state: testStateView({
          assignedTasks: [
            {
              ...taskOf('assigned'),
              workflowContext: 'instance-1 is confirmed (running); completed steps: Implementation; evidence keys: index.html',
            },
          ],
        }),
      }),
    );
    expect(prompt).toContain('workflow: instance-1 is confirmed');
    expect(prompt).toContain('evidence keys: index.html');
  });

  it('no longer contradicts itself on the executor action space', () => {
    const prompt = buildCognitionPrompt(
      testContext({ state: testStateView({ assignedTasks: [taskOf('assigned')] }) }),
    );
    // The protocol block must tell the model not to re-accept — the transition that burned live runs.
    expect(prompt).toContain('invalid_transition');
    expect(prompt).toContain('Do not AcceptTask an already accepted task');
  });
});
