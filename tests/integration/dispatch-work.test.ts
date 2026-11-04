import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CorrelationId } from '@maoeh/shared-types';
import type { LlmRequest } from '@maoeh/llm-gateway';
import { PLAN_ACTION_BINDINGS, workCatalogView } from '@maoeh/kernel';
import { createInMemoryWorkflowDefinitionStore } from '@maoeh/workflow-engine';
import { validOutput } from '../helpers/cognition-fixtures';
import { collectEvents, createControlHarness, type ControlHarness } from '../helpers/control-fixtures';
import { loadSeedWorkflows, planForPrompt } from '../helpers/simulation-fixtures';

/**
 * M1.4 acceptance 1/2/8: a work brief arrives (here as an operator instruction), the briefed
 * manager's plan decomposes it into `DispatchWork` steps, and the kernel turns each step into
 * a task on a *position* that wakes its assignee on the next tick. `DispatchWork` is the only
 * write path: no plan action reaches `tasks.create`/`tasks.assign` directly (acceptance 8).
 *
 * Cognition is scripted per seat through `system`: the manager sees the duties block that the
 * `workCatalog` injection adds, everyone else falls back to the repository's task driver.
 */
const DISPATCH_PLAN = validOutput({
  goal: 'the brief is decomposed into assigned work',
  doneWhen: 'two work items sit assigned on two different positions',
  steps: [
    {
      action: 'DispatchWork',
      args: {
        positionId: 'engineer',
        title: 'Build login API',
        goal: 'Deliver a minimal login endpoint',
        detail: 'From the brief: minimal login endpoint with tests.',
        requiredSkills: ['backend'],
        requiredOutputKeys: ['endpoint', 'tests'],
        priority: 3,
      },
      reasonRef: 0,
    },
    {
      action: 'DispatchWork',
      args: {
        positionId: 'qa',
        title: 'Verify login flow',
        goal: 'Cover the login flow with tests',
        requiredOutputKeys: ['test-report'],
        priority: 3,
      },
      reasonRef: 1,
    },
  ],
});

interface DispatchHarness {
  readonly control: ControlHarness;
  readonly requests: readonly LlmRequest[];
}

async function createDispatchHarness(): Promise<DispatchHarness> {
  const requests: LlmRequest[] = [];
  const control = await createControlHarness({
    llmText(request) {
      requests.push(request);
      return request.system.startsWith('You are Alex')
        ? DISPATCH_PLAN
        : planForPrompt(request.prompt);
    },
  });
  return { control, requests };
}

function assignmentOf(event: { readonly payload: unknown }): {
  readonly positionId: string | null;
  readonly assigneeEmployeeId: string | null;
} {
  const payload = event.payload as {
    readonly assignment?: { readonly positionId?: string | null; readonly assigneeEmployeeId?: string | null };
  };
  return {
    positionId: payload.assignment?.positionId ?? null,
    assigneeEmployeeId: payload.assignment?.assigneeEmployeeId ?? null,
  };
}

describe('M1.4 dispatch work: brief -> positions -> wake assignees', () => {
  it('turns one brief into two work items on two positions and wakes both assignees (acceptance 1+2)', async () => {
    const { control: h, requests } = await createDispatchHarness();
    await h.plane.control.execute(h.command('Simulation.Start'));

    const instruction = await h.plane.control.execute(
      h.command('Agent.Instruct', {
        targetId: 'ceo-alex',
        reason: 'quarterly brief',
        extra: { instruction: 'Deliver the login feature this sprint.' },
      } as never),
    );
    expect(instruction.status, JSON.stringify(instruction.failure)).toBe('accepted');

    // Tick 1: the briefed CEO gets one turn and runs the decomposition plan.
    const tick1 = await h.simulation.tick();
    const ceoTurn = tick1.turns.find((turn) => turn.employeeId === 'ceo-alex');
    expect(ceoTurn, 'the briefed CEO must get a turn').toBeDefined();
    expect(ceoTurn?.status).toBe('acted');

    const events = await collectEvents(h.simulation.eventStore);
    const instructionEvent = events.find(
      (event) => event.eventId === instruction.events[0],
    );
    expect(instructionEvent, 'the instruction event must be on the log').toBeDefined();
    const briefCorrelationId = instructionEvent?.correlationId;

    // Acceptance 1: one brief -> two work items -> two different positions.
    const assigned = events.filter(
      (event) =>
        event.type === 'Task.Assigned' && event.correlationId === briefCorrelationId,
    );
    expect(assigned, 'one brief must produce two dispatched work items').toHaveLength(2);
    const positions = assigned.map((event) => assignmentOf(event).positionId);
    expect([...new Set(positions)].sort()).toEqual(['engineer', 'qa']);
    const assignees = assigned
      .map((event) => assignmentOf(event).assigneeEmployeeId)
      .sort();
    expect(assignees).toEqual(['engineer-mike', 'qa-peter']);

    const tasks = h.simulation.tasks
      .all()
      .filter((task) => task.correlationId === briefCorrelationId);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.status === 'assigned')).toBe(true);

    // The manager's system prompt carried the duties block the work catalog gates on.
    const managerRequest = requests.find((request) =>
      request.system.startsWith('You are Alex'),
    );
    expect(managerRequest, 'the CEO plan request must exist').toBeDefined();
    expect(managerRequest?.system).toContain('Your duties as a manager');

    // Acceptance 2: Task.Assigned wakes both assignees within the next tick.
    const tick2 = await h.simulation.tick();
    const acted = tick2.turns
      .filter((turn) => turn.status === 'acted')
      .map((turn) => turn.employeeId);
    expect(acted).toEqual(expect.arrayContaining(['engineer-mike', 'qa-peter']));

    // Seats without the grant never see the duties block.
    const subordinateRequest = requests.find(
      (request) => !request.system.startsWith('You are Alex'),
    );
    expect(subordinateRequest, 'a subordinate plan request must exist').toBeDefined();
    expect(subordinateRequest?.system).not.toContain('Your duties as a manager');
  });

  it('keeps raw tasks.create / tasks.assign unreachable from agent-side code (acceptance 8)', () => {
    const bindings = Object.values(PLAN_ACTION_BINDINGS);
    expect(bindings).toContain('tasks.dispatch');
    expect(bindings).not.toContain('tasks.create');
    expect(bindings).not.toContain('tasks.assign');

    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const rawWrite = /tasks\.(create|assign)\s*\(/;

    // The kernel is where agent plans execute: only `tasks.dispatch` may appear there.
    const kernelFiles = listSourceFiles(join(repoRoot, 'apps', 'kernel', 'src'));
    expect(kernelFiles.length).toBeGreaterThan(0);
    const kernelOffenders = kernelFiles.filter((file) =>
      rawWrite.test(readFileSync(file, 'utf8')),
    );
    expect(kernelOffenders, 'kernel sources must dispatch, never create/assign directly').toEqual(
      [],
    );

    // API-side handlers go through the control plane, not the task service.
    const apiFiles = listSourceFiles(join(repoRoot, 'apps', 'api', 'src'));
    const apiOffenders = apiFiles.filter((file) =>
      rawWrite.test(readFileSync(file, 'utf8')),
    );
    expect(apiOffenders, 'apps/api must not reach the task service write commands').toEqual([]);

    // Inside packages, only the task service itself, the workflow engine (its caller), and
    // the human control plane (operator commands with their own authz) may write tasks.
    const allowedPackages = new Set(['task-system', 'workflow-engine', 'organization-control']);
    const packagesRoot = join(repoRoot, 'packages');
    const offenders: string[] = [];
    for (const packageName of readdirSync(packagesRoot)) {
      if (allowedPackages.has(packageName)) continue;
      const src = join(packagesRoot, packageName, 'src');
      if (!existsSync(src)) continue;
      for (const file of listSourceFiles(src)) {
        if (rawWrite.test(readFileSync(file, 'utf8'))) offenders.push(file);
      }
    }
    expect(offenders, 'no other package may call tasks.create/assign').toEqual([]);
  });

  it('assembles the work catalog from live stores with the real dispatch permission', async () => {
    const h = await createControlHarness();
    const definitions = createInMemoryWorkflowDefinitionStore(loadSeedWorkflows());
    const catalogInput = {
      organization: h.organization,
      tasks: h.simulation.tasks,
      definitions,
      instances: h.simulation.instanceStore,
      authz: h.simulation.authz,
    };
    const correlationId = 'corr-work-catalog' as CorrelationId;

    const manager = workCatalogView(
      catalogInput,
      h.harness.identity.actorContext('ceo-alex', correlationId),
    );
    expect(manager.canDispatchWork).toBe(true);
    expect(manager.workflows.length).toBeGreaterThan(0);
    expect(manager.inFlightWorkflows).toBe(0);
    const engineerSeat = manager.positions.find(
      (position) => position.positionId === 'engineer',
    );
    expect(engineerSeat).toBeDefined();
    expect(engineerSeat?.openTaskCount).toBe(0);

    const subordinate = workCatalogView(
      catalogInput,
      h.harness.identity.actorContext('engineer-mike', correlationId),
    );
    expect(subordinate.canDispatchWork).toBe(false);
  });
});

function listSourceFiles(directory: string): readonly string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(path);
      }
    }
  };
  walk(directory);
  return files;
}
