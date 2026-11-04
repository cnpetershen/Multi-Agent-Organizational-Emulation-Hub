import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import { requiredCapabilitiesFor } from '@maoeh/organization-model';
import { deterministicCognitionText } from '../../apps/api/src/deterministic-cognition';
import { collectEvents } from '../helpers/control-fixtures';
import type { AcceptanceHarness } from './runtime-harness';
import { createAcceptanceHarness } from './runtime-harness';

/**
 * The reported symptom, reproduced as an acceptance claim.
 *
 * A user dropped a snake-game task book into the company and got back "a series of steps and
 * nothing to play": the workflow finished, but every task had submitted the *same* constant
 * object with no artifacts, so the delivery page showed churn-analysis boilerplate for a game.
 *
 * This test runs the mandate through the real chain with the *production* cognition
 * (`deterministicCognitionText` — the exact function `apps/api` composes the runtime with), and
 * asserts what the user sees on the delivery page:
 *
 *   1. the mandate is analysed into capabilities and routed to the seats that declare them;
 *   2. the composing seat (the CEO) hands the work out and does not execute it;
 *   3. the executor's work product is a runnable artifact whose content is about *this* mandate;
 *   4. it is not the constant placeholder every earlier task submitted.
 */

const GAME_MANDATE = '写一个 Web 端的贪吃蛇小游戏';
const OLD_PLACEHOLDER = 'root causes identified';

async function runToIdle(harness: AcceptanceHarness, maxTicks = 10): Promise<void> {
  for (let index = 0; index < maxTicks; index += 1) {
    const result = await harness.control.simulation.tick();
    if (result.status === 'idle') return;
  }
}

describe('M1.6 acceptance · a game mandate becomes a real delivery', () => {
  it('analyses the mandate, routes it to the builder, and delivers runnable code', async () => {
    // 1. Deterministic goal analysis: the Chinese build cue plus the web cue stack two
    //    capabilities (and `frontend` pulls in its `implementation` parent).
    expect(requiredCapabilitiesFor(GAME_MANDATE)).toEqual(['implementation', 'frontend']);

    const harness = await createAcceptanceHarness({ llmText: deterministicCognitionText });
    const instructed = await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: GAME_MANDATE,
      reason: 'board directive',
    });
    expect(instructed.status, JSON.stringify(instructed.failure)).toBe('accepted');

    await runToIdle(harness);

    const instances = harness.control.simulation.instanceStore.all();
    expect(instances).toHaveLength(1);
    const instance = instances[0];
    expect(instance).toBeDefined();
    if (instance === undefined) return;

    // The work is named after the mandate itself, not a constant "Board directive".
    expect(instance.title).toBe(GAME_MANDATE);
    expect(instance.status).toBe('completed');

    const tasks = harness.control.simulation.taskStore.all();
    expect(tasks.length).toBeGreaterThan(0);

    // 2. Management decomposes and dispatches; it does not take an execution step. The seat that
    //    composed the plan (the CEO) is never the assignee of its own plan's work.
    expect(tasks.every((task) => task.assignment.assigneeEmployeeId !== 'ceo-alex')).toBe(true);

    // 3. The builder (the seat declaring `implementation`/`frontend`) holds both steps, and each
    //    step hands back the part *its own capability* owns — the playable page is the frontend
    //    step's work, not one copy per step under different folder names.
    const builderSteps = tasks.filter((task) => task.assignment.assigneeEmployeeId === 'engineer-mike');
    expect(builderSteps.map((task) => task.capability)).toEqual(['implementation', 'frontend']);
    const builderTask = builderSteps.find((task) => task.capability === 'frontend');
    expect(builderTask).toBeDefined();
    expect(builderTask?.status).toBe('completed');
    const result = builderTask?.result;
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    if (result === null || result === undefined) return;

    // 4. The work product is *this* mandate's, and it is a runnable artifact — not the constant
    //    placeholder that made every earlier delivery look identical.
    expect(result.summary).toContain(GAME_MANDATE);
    expect(result.artifacts.some((artifact) => artifact.endsWith('.html'))).toBe(true);

    const data = result.data;
    expect(typeof data['entrypoint']).toBe('string');
    expect(String(data['entrypoint']).endsWith('.html')).toBe(true);
    const content = data['content'];
    expect(typeof content).toBe('string');
    expect(String(content)).toContain('<!doctype html');
    expect(String(content)).toContain(GAME_MANDATE);
    // The delivery is the *game*, not a page that only renders the step's name: a canvas board
    // with a running game loop is what a human opens and plays.
    expect(String(content)).toContain('<canvas id="board"');
    expect(String(content)).toContain('requestAnimationFrame');
    expect(String(content)).toContain('function step');
    expect(JSON.stringify(data)).not.toContain(OLD_PLACEHOLDER);

    // 6. The implementation step owns the *wiring* rather than a second copy of the page: one
    //    command runs the product the frontend step delivered. This is the other half of the
    //    reported defect — three capability steps used to hand back one identical artifact.
    const wiring = builderSteps.find((task) => task.capability === 'implementation');
    expect(wiring?.status).toBe('completed');
    expect(wiring?.result?.artifacts).toEqual(['run.py', 'README.md']);
    expect(String(wiring?.result?.data['content'])).toContain('webbrowser');
    expect(String((wiring?.result?.data['files'] as readonly { content: string }[])[1]?.content)).toContain(
      'client/index.html',
    );

    // 5. The CEO still did its own job: it composed the plan and closed the gate.
    const events: readonly OrgEvent[] = await collectEvents(harness.control.simulation.eventStore);
    const types = events.map((event) => event.type);
    expect(types).toContain('Workflow.ApprovalRequested');
    expect(types).toContain('Workflow.ApprovalGranted');
    expect(types).toContain('Workflow.InstanceCompleted');
  });
});
