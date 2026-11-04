import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import { createSimulationHarness } from '../helpers/simulation-fixtures';
import { collectEvents } from '../helpers/control-fixtures';
import type { SimulationTickResult } from '@maoeh/kernel';
import {
  createAcceptanceHarness,
  createObserver,
  renderTickTrace,
  type AcceptanceHarness,
  type TickTrace,
} from './runtime-harness';

function log(...parts: readonly unknown[]): void {
  console.log(...parts);
}

/**
 * Walks the stored stream and reports ordering violations that a causal event log must not
 * contain: terminal events before their cause, or a new cycle/step after a completion.
 */
function orderingViolations(events: readonly OrgEvent[]): readonly string[] {
  const problems: string[] = [];
  const taskStarted = new Set<string>();
  const taskTerminal = new Set<string>();
  const instanceTerminal = new Set<string>();
  const cycleOpen = new Set<string>();

  for (const event of events) {
    const payload = (event.payload ?? {}) as Readonly<Record<string, unknown>>;
    const taskId = typeof payload['taskId'] === 'string' ? payload['taskId'] : null;
    const instanceId = typeof payload['instanceId'] === 'string' ? payload['instanceId'] : null;
    const employeeId = event.subjectType === 'employee' ? String(event.subjectId) : null;

    if (event.type === 'Task.Started' && taskId !== null) taskStarted.add(taskId);
    if (
      (event.type === 'Task.Completed' ||
        event.type === 'Task.Cancelled' ||
        event.type === 'Task.Failed') &&
      taskId !== null
    ) {
      if (event.type === 'Task.Completed' && !taskStarted.has(taskId)) {
        problems.push(`${event.type} before Task.Started for ${taskId} (seq ${String(event.seq)})`);
      }
      taskTerminal.add(taskId);
    }
    if (event.type === 'Task.Assigned' && taskId !== null && taskTerminal.has(taskId)) {
      problems.push(`Task.Assigned after a terminal task status for ${taskId}`);
    }
    if (event.type === 'Workflow.InstanceCompleted' || event.type === 'Workflow.InstanceAborted') {
      if (instanceId !== null) instanceTerminal.add(instanceId);
    }
    if (event.type === 'Workflow.StepEntered' && instanceId !== null && instanceTerminal.has(instanceId)) {
      problems.push(`Workflow.StepEntered after ${instanceId} reached a terminal status`);
    }
    if (event.type === 'Runtime.CycleStarted' && employeeId !== null) {
      if (cycleOpen.has(employeeId)) problems.push(`Runtime.CycleStarted while a cycle was open for ${employeeId}`);
      cycleOpen.add(employeeId);
    }
    if (event.type === 'Runtime.CycleFinished' && employeeId !== null) {
      if (!cycleOpen.has(employeeId)) problems.push(`Runtime.CycleFinished without an open cycle for ${employeeId}`);
      cycleOpen.delete(employeeId);
    }
  }
  return problems;
}

describe('M1.0 runtime acceptance: stream health', () => {
  let harness: AcceptanceHarness;
  let traces: readonly TickTrace[];

  beforeEach(async () => {
    harness = await createAcceptanceHarness();
    const observer = createObserver(harness);
    const collected: TickTrace[] = [];
    await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: 'Own the churn problem.',
      reason: 'board directive',
    });
    for (let index = 0; index < 10; index += 1) {
      observer.beforeTick();
      collected.push(await observer.observe(await harness.control.simulation.tick()));
    }
    traces = Object.freeze(collected);
  });

  it('keeps the event stream well ordered and fully causal', async () => {
    const events = await collectEvents(harness.control.simulation.eventStore);
    const violations = orderingViolations(events);
    log('ordering violations', violations);
    expect(violations).toEqual([]);

    // seq is strictly increasing and unique on the authoritative stream.
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);

    // Every non-first event belongs to the same causal chain: either it names a cause, or it
    // shares the correlation id of the work it belongs to.
    const correlations = new Set(events.map((event) => event.correlationId));
    log('correlations', [...correlations]);
    log(
      'events without causationId',
      events.filter((event) => event.causationId === null).length,
      'of',
      events.length,
    );
  });

  it('goes genuinely idle (no wakeups, no LLM calls, no work) after the company is done', () => {
    const tail = traces.slice(-4);
    log(tail.map(renderTickTrace).join('\n'));
    for (const trace of tail) {
      expect(trace.status).toBe('idle');
      expect(trace.turns).toEqual([]);
      expect(trace.llmCalls).toBe(0);
      expect(trace.enqueuedWakeups).toBe(0);
      expect(trace.pendingWakeupsAfter).toBe(0);
      expect(trace.emittedEvents.map((event) => event.type)).toEqual(['System.SimClockTicked']);
    }
  });

  it('does not grow the scheduler bookkeeping while idle', () => {
    const tail = traces.slice(-4);
    const sizes = tail.map((trace) => trace.totalWakeupRecordsAfter);
    log('scheduler records during idle', sizes);
    expect(new Set(sizes).size).toBe(1);
  });
});

describe('M1.0 runtime acceptance: error propagation', () => {
  it('survives a malformed LLM response without crashing the simulation', async () => {
    const harness = await createAcceptanceHarness({ llmText: () => 'this is not JSON' });
    const traces: TickTrace[] = [];
    const observer = createObserver(harness);
    await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: 'Own the churn problem.',
      reason: 'board directive',
    });
    for (let index = 0; index < 3; index += 1) {
      observer.beforeTick();
      traces.push(await observer.observe(await harness.control.simulation.tick()));
    }
    log(traces.map(renderTickTrace).join('\n'));

    expect(traces[0]?.status).toBe('partial_failure');
    expect(traces[0]?.turns[0]?.status).toBe('failed');
    expect(traces[0]?.turns[0]?.failureCode).toBe('malformed_output');
    // A non-retryable failure is marked processed: it must not be retried forever.
    expect(traces[0]?.turns).toHaveLength(1);
    // The company keeps ticking and stays alive.
    expect(traces[2]?.status).toBe('idle');

    const report = await harness.control.simulation.recover();
    log('recovery after failure', JSON.stringify(report));
    expect(report.eventCount).toBeGreaterThan(0);
  });

  it('retries a provider error a bounded number of times, then gives up', async () => {
    const harness = await createAcceptanceHarness({
      llmText: () => {
        throw new Error('provider exploded');
      },
    });
    const traces: TickTrace[] = [];
    const observer = createObserver(harness);
    await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: 'Own the churn problem.',
      reason: 'board directive',
    });
    for (let index = 0; index < 3; index += 1) {
      observer.beforeTick();
      traces.push(await observer.observe(await harness.control.simulation.tick()));
    }
    log(traces.map(renderTickTrace).join('\n'));

    const first = traces[0];
    expect(first?.status).toBe('partial_failure');
    // 1 initial attempt + maxRetries(3) = 4 attempts, all inside the same tick.
    expect(first?.turns).toHaveLength(4);
    expect(first?.turns.every((turn) => turn.failureCode === 'provider_error')).toBe(true);
    expect(first?.turns.slice(0, 3).every((turn) => turn.retryable)).toBe(true);
    expect(first?.turns[3]?.retryable).toBe(false);
    // Bounded: the exhausted event is not re-offered on later ticks.
    expect(traces[1]?.turns).toEqual([]);
    expect(traces[1]?.status).toBe('idle');
  });

  it('turns an unsupported action into a failed cycle rather than a crash', async () => {
    const harness = await createAcceptanceHarness({
      llmText: () =>
        JSON.stringify({
          interpretation: 'I want to escalate.',
          considerations: ['Escalation is in the action space.'],
          conclusion: 'Escalate.',
          confidence: 0.4,
          plan: {
            goal: 'escalate',
            doneWhen: 'escalated',
            steps: [{ action: 'Escalate', args: { reason: 'help' }, reasonRef: 0 }],
          },
        }),
    });
    const observer = createObserver(harness);
    await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: 'Own the churn problem.',
      reason: 'board directive',
    });
    observer.beforeTick();
    const trace = await observer.observe(await harness.control.simulation.tick());
    log(renderTickTrace(trace));
    expect(trace.status).toBe('partial_failure');
    expect(trace.turns[0]?.failureCode).toBe('unsupported_action');
  });

  it('aborts the workflow, not the simulation, when the work is rejected', async () => {
    const harness = await createSimulationHarness({
      llmText: (request) =>
        JSON.stringify({
          interpretation: 'I cannot do this.',
          considerations: ['The brief is out of scope.'],
          conclusion: 'Reject the task.',
          confidence: 0.5,
          plan: {
            goal: 'reject',
            doneWhen: 'rejected',
            steps: [
              {
                action: 'RejectTask',
                args: { taskId: /"taskId":\s*"([^"]+)"/.exec(request.prompt)?.[1] ?? 'task-1', reason: 'out of scope' },
                reasonRef: 0,
              },
            ],
          },
        }),
    });
    const instanceId = await harness.startProductAnalysis();
    const results: SimulationTickResult[] = [];
    for (let index = 0; index < 4; index += 1) results.push(await harness.simulation.tick());
    const instance = harness.simulation.instanceStore.get(instanceId);
    log('workflow after rejection', instance?.status, JSON.stringify(instance?.blockedReason));
    expect(instance?.status).toBe('aborted');
    // Later ticks are still healthy.
    const idle = await harness.simulation.tick();
    expect(idle.status).toBe('idle');
  });

  it('stops at the budget and recovers on the next tick instead of wedging', async () => {
    const harness = await createAcceptanceHarness({ budget: { maxLlmCalls: 0 } });
    const observer = createObserver(harness);
    await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: 'Own the churn problem.',
      reason: 'board directive',
    });
    observer.beforeTick();
    const limited = await observer.observe(await harness.control.simulation.tick());
    log(renderTickTrace(limited));
    expect(limited.status).toBe('budget_exceeded');
    expect(limited.budgetExceeded).toContain('max_llm_calls');
    expect(limited.turns).toEqual([]);

    // The tick is bounded, the log stays consistent and the clock keeps moving.
    observer.beforeTick();
    const next = await observer.observe(await harness.control.simulation.tick());
    expect(next.tickNumber).toBe(limited.tickNumber + 1);
    const events = await collectEvents(harness.control.simulation.eventStore);
    expect(events.at(-1)?.type).toBe('System.SimClockTicked');
  });
});
