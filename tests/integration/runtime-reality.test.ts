import { describe, expect, it } from 'vitest';
import type { OrgEvent, SimTime } from '@maoeh/shared-types';
import type { ControlCommand } from '@maoeh/organization-control';
import { startTickDriver } from '@maoeh/kernel';
import { createComposedRuntime, startApiServer } from '../../apps/api/src/composition';
import { collectEvents } from '../helpers/control-fixtures';

/**
 * M1.2-A runtime reality: the console's minimal business chain has to be real.
 *
 *   Human -> CEO -> cognition -> task/workflow -> CTO -> cognition -> result
 *
 * The LLM is the repository's mock provider (there is no other), so what is under test is
 * everything around it: the composed runtime, the control plane, the kernel tick loop, the
 * task and workflow state machines, the event log and the HTTP surface the console reads.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

let commandSeq = 0;
function operatorCommand(
  commandType: ControlCommand['commandType'],
  overrides: Readonly<Record<string, unknown>> = {},
): ControlCommand {
  commandSeq += 1;
  const commandId = `cmd-m12a-${String(commandSeq)}`;
  return {
    commandId,
    commandType,
    actor: { operatorId: 'ceo-alex', displayName: 'Alex', positionId: 'ceo', kind: 'human' },
    target: { targetType: 'simulation', targetId: 'future-ai-lab' },
    reason: 'M1.2-A runtime reality verification',
    correlationId: commandId,
    causationId: null,
    createdAtSim: 0 as SimTime,
    ...overrides,
  } as ControlCommand;
}

const instructCommand = (instruction: string): ControlCommand =>
  operatorCommand('Agent.Instruct', {
    target: { targetType: 'agent', targetId: 'ceo-alex' },
    instruction,
  });

function payloadOf(event: OrgEvent): Readonly<Record<string, unknown>> {
  return (typeof event.payload === 'object' && event.payload !== null
    ? event.payload
    : {}) as Readonly<Record<string, unknown>>;
}

/** `EventView` carries the payload nested, unlike the stored `OrgEvent`. */
function viewPayload(view: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const payload = view['payload'];
  return (typeof payload === 'object' && payload !== null
    ? payload
    : {}) as Readonly<Record<string, unknown>>;
}

function cyclesOf(events: readonly OrgEvent[]): readonly Readonly<Record<string, unknown>>[] {
  return events.filter((event) => event.type === 'Runtime.CycleFinished').map(payloadOf);
}

describe('M1.2-A: the composed runtime actually runs the minimal business chain', () => {
  it('drives Human -> CEO -> cognition -> task/workflow -> CTO -> cognition -> result', async () => {
    const { simulation, api } = await createComposedRuntime({ eventLogPath: null, requirePlanConfirmation: false });
    const driver = startTickDriver(simulation, { activeIntervalMs: 2, idleIntervalMs: 25 });
    try {
      const instructed = await api.control.execute(
        instructCommand('Own the churn problem and drive it to a decision.'),
      );
      expect(instructed.status, JSON.stringify(instructed.failure)).toBe('accepted');

      await waitFor(
        () => simulation.instanceStore.all().some((instance) => instance.status === 'blocked' || instance.status === 'completed'),
        'the product-analysis workflow to reach its final gate',
      );
      const gated = simulation.instanceStore.all().find((instance) => instance.status === 'blocked');
      if (gated !== undefined) {
        const approved = await api.control.execute(operatorCommand('Workflow.Approve', {
          target: { targetType: 'workflow', targetId: gated.instanceId },
          reason: 'human acceptance of the product analysis',
        }));
        expect(approved.status, JSON.stringify(approved.failure)).toBe('accepted');
      }
      await waitFor(
        () => simulation.instanceStore.all().some((instance) => instance.status === 'completed'),
        'the human-accepted workflow to complete',
      );

      const events = await collectEvents(simulation.eventStore);
      const types = events.map((event) => event.type);

      // Causal chain: a human instruction reached the CEO and ended in a result.
      expect(types).toContain('Control.AgentInstructed');
      expect(types).toContain('Workflow.InstanceStarted');
      expect(types).toContain('Workflow.InstanceCompleted');
      expect(types.filter((type) => type === 'Task.Completed').length).toBeGreaterThanOrEqual(3);

      // Both the CEO and the CTO did real work (not a schema-violating no-op).
      const cycles = cyclesOf(events);
      expect(cycles.length).toBeGreaterThan(0);
      const employees = cycles.map((cycle) => String(cycle['employeeId']));
      expect(employees).toContain('ceo-alex');
      expect(employees).toContain('cto-john');
      expect(
        cycles.filter((cycle) => Number(cycle['actionCount']) > 0).length,
        'cycles must execute plan actions',
      ).toBeGreaterThan(0);

      // The root cause of "the organization does nothing": every turn used to fail with
      // `schema_violation` because the mock returned an empty plan.
      const failures = cycles
        .map((cycle) => cycle['failureCode'])
        .filter((code) => code !== null && code !== undefined)
        .filter((code) => code !== 'human_approval_required');
      expect(failures).toEqual([]);
      expect(types.filter((type) => type === 'Task.ProgressReported').length).toBeGreaterThan(0);

      const tasks = simulation.taskStore.all();
      expect(tasks.length).toBeGreaterThanOrEqual(3);
      expect(tasks.filter((task) => task.status === 'completed').length).toBeGreaterThanOrEqual(3);

      // The LLM path was exercised (mock provider = current production substrate).
      expect(api.llm?.().callCount ?? 0).toBeGreaterThan(0);

      // Nothing left to do: the runtime settles instead of spinning.
      await waitFor(
        () => simulation.lastTickResult?.status === 'idle',
        'the runtime to go idle after the work is done',
      );
      expect(simulation.scheduler.pending()).toEqual([]);
    } finally {
      driver.stop();
    }
  });

  it('keeps ticking on its own, freezes on Pause and resumes on Resume', async () => {
    const { simulation, api } = await createComposedRuntime({ eventLogPath: null, requirePlanConfirmation: false });
    const driver = startTickDriver(simulation, { activeIntervalMs: 5, idleIntervalMs: 20 });
    try {
      // RT-1/RT-2: no manual Step, no manual POST /api/tick - the runtime advances alone.
      await waitFor(
        () => simulation.scheduler.clock.currentTick >= 3,
        'the runtime to advance without manual ticks',
        10_000,
      );
      expect(driver.ticks).toBeGreaterThan(0);

      const paused = await api.control.execute(operatorCommand('Simulation.Pause'));
      expect(paused.status).toBe('accepted');
      expect(simulation.scheduler.paused).toBe(true);

      // Let the tick in flight when the pause landed settle, then watch.
      await sleep(60);
      const frozen = simulation.scheduler.clock.currentTick;
      const ticksWhilePaused = driver.ticks;
      await sleep(250);
      expect(simulation.scheduler.clock.currentTick).toBe(frozen);
      expect(driver.ticks).toBe(ticksWhilePaused);
      expect(simulation.lastTickResult?.status).not.toBe('ok');

      const resumed = await api.control.execute(operatorCommand('Simulation.Resume'));
      expect(resumed.status).toBe('accepted');
      expect(simulation.scheduler.paused).toBe(false);
      await waitFor(
        () => simulation.scheduler.clock.currentTick > frozen,
        'the runtime to advance after Resume',
        10_000,
      );
    } finally {
      driver.stop();
    }
  });

  it('backs off when there is nothing to do instead of busy-looping', async () => {
    const { simulation } = await createComposedRuntime({ eventLogPath: null, requirePlanConfirmation: false });
    const driver = startTickDriver(simulation, { activeIntervalMs: 1, idleIntervalMs: 60_000 });
    try {
      await waitFor(() => driver.ticks >= 1, 'the first keep-alive tick', 5_000);
      await sleep(400);
      // A busy loop at the active interval would have issued hundreds of ticks here.
      expect(driver.ticks).toBeLessThanOrEqual(3);
      expect(simulation.lastTickResult?.status).toBe('idle');
    } finally {
      driver.stop();
    }
  });

  it('serves the running console over HTTP: command, auto-tick, LLM and queries', async () => {
    const server = await startApiServer(0, { requirePlanConfirmation: false,  tick: { activeIntervalMs: 5, idleIntervalMs: 50 }, eventLogPath: null });
    const base = `http://127.0.0.1:${String(server.port)}/api`;
    try {
      const post = async (path: string, body: unknown): Promise<Response> =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', connection: 'close' },
          body: JSON.stringify(body),
        });
      const get = async <T>(path: string): Promise<T> =>
        (await (await fetch(`${base}${path}`, { headers: { connection: 'close' } })).json()) as T;

      const instructed = await post('/command', instructCommand('Own the churn problem.'));
      expect(instructed.status).toBe(200);
      const outcome = (await instructed.json()) as { status: string; failure: unknown };
      expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

      // Auto-tick: the tick number moves with nobody calling /api/tick.
      const before = await get<{ tick: number }>('/simulation');
      await sleep(400);
      const after = await get<{ tick: number }>('/simulation');
      expect(after.tick).toBeGreaterThan(before.tick);

      // The chain reaches its final human gate through the HTTP surface.
      await waitFor(async () => {
        const workflows = await get<readonly { status: string; instanceId: string }[]>('/workflows');
        return workflows.some((workflow) => workflow.status === 'blocked' || workflow.status === 'completed');
      }, 'the workflow to reach its gate over HTTP');
      const gatedWorkflows = await get<readonly { status: string; instanceId: string }[]>('/workflows');
      const waiting = gatedWorkflows.filter((workflow) => workflow.status === 'blocked');
      for (const workflow of waiting) {
        const approved = await post('/command', operatorCommand('Workflow.Approve', {
          target: { targetType: 'workflow', targetId: workflow.instanceId },
          reason: 'human acceptance over HTTP',
        }));
        expect(approved.status).toBe(200);
      }
      await waitFor(async () => {
        const workflows = await get<readonly { status: string }[]>('/workflows');
        return workflows.some((workflow) => workflow.status === 'completed');
      }, 'the human-accepted workflow to complete over HTTP');

      const tasks = await get<readonly { status: string }[]>('/tasks');
      expect(tasks.filter((task) => task.status === 'completed').length).toBeGreaterThanOrEqual(3);

      const llm = await get<{ callCount: number }>('/llm');
      expect(llm.callCount).toBeGreaterThan(0);

      const events = await get<readonly Readonly<Record<string, unknown>>[]>('/events?limit=200');
      // M1.2-B: the feed the console renders is company activity �?the per-tick clock
      // markers stay in the store but must not fill the window the operator sees.
      expect(events.filter((event) => event['type'] === 'System.SimClockTicked')).toEqual([]);
      // ...and they are still one explicit query away.
      const clock = await get<readonly Readonly<Record<string, unknown>>[]>(
        '/events?limit=5&prefix=System.',
      );
      expect(clock.length).toBeGreaterThan(0);
      expect(clock.every((event) => event['type'] === 'System.SimClockTicked')).toBe(true);
      const cycles = events
        .filter((event) => event['type'] === 'Runtime.CycleFinished')
        .map(viewPayload);
      expect(cycles.length).toBeGreaterThan(0);
      expect(cycles.some((cycle) => Number(cycle['actionCount'] ?? 0) > 0)).toBe(true);
      expect(
        cycles.map((cycle) => cycle['failureCode'])
          .filter((code) => code !== null && code !== 'human_approval_required'),
        'only the agent approval refused by the human gate may fail',
      ).toEqual([]);

      // Pause/Resume work over HTTP too, and the driver obeys them.
      const paused = await post('/command', operatorCommand('Simulation.Pause'));
      expect(paused.status).toBe(200);
      await sleep(80);
      const frozen = (await get<{ tick: number }>('/simulation')).tick;
      await sleep(250);
      expect((await get<{ tick: number }>('/simulation')).tick).toBe(frozen);
      expect((await get<{ paused: boolean }>('/simulation')).paused).toBe(true);

      const resumed = await post('/command', operatorCommand('Simulation.Resume'));
      expect(resumed.status).toBe(200);
      await waitFor(async () => {
        const state = await get<{ tick: number; paused: boolean }>('/simulation');
        return !state.paused && state.tick > frozen;
      }, 'the runtime to advance after an HTTP Resume');
    } finally {
      await server.close();
    }
  });
});

