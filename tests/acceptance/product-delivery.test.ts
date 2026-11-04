import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import { requiredCapabilitiesFor } from '@maoeh/organization-model';
import { deterministicCognitionText } from '../../apps/api/src/deterministic-cognition';
import { collectEvents } from '../helpers/control-fixtures';
import type { AcceptanceHarness } from './runtime-harness';
import { createAcceptanceHarness } from './runtime-harness';

/**
 * The reported defect, as an acceptance claim: *the delivered product has to be the product the
 * requirement asked for.*
 *
 * A real company (`ss`) handed the organization "开发一个俄罗斯方块程序" with the requirement
 * "前端Web SPA 后端用python，后端用来记录每次排名和得分". The workflow that came back had the
 * right three stages — Implementation, Frontend, Backend — but every one of them submitted the
 * *same* client-side page, because the delivery was shaped from the executor's own seat tags
 * rather than from the capability the step declared: one seat declares implementation, frontend
 * and backend, so all three steps answered "code" with the one artifact that existed.
 *
 * This runs the same mandate through the real chain (production cognition, real capability
 * routing, real workflow engine, real task contract) and asserts what an owner now holds when it
 * finishes:
 *
 *   1. three steps, one per capability, each carrying its declared capability to its executor;
 *   2. the frontend step hands back the SPA, wired to a service it does not itself deliver;
 *   3. the backend step hands back a runnable Python service that records plays and ranks them;
 *   4. the implementation step hands back the wiring that runs both halves with one command;
 *   5. the halves agree on the API, because both are generated from the same requirement.
 */

const REQUIREMENT = '前端Web SPA 后端用python，后端用来记录每次排名和得分';
const MANDATE = `开发一个俄罗斯方块程序\n${REQUIREMENT}`;

interface DeliveredFile {
  readonly path: string;
  readonly language: string;
  readonly content: string;
}

async function runToIdle(harness: AcceptanceHarness, maxTicks = 20): Promise<void> {
  for (let index = 0; index < maxTicks; index += 1) {
    const result = await harness.control.simulation.tick();
    if (result.status === 'idle') return;
  }
}

function filesOf(data: Readonly<Record<string, unknown>>): readonly DeliveredFile[] {
  const files = data['files'];
  expect(Array.isArray(files), 'the delivery lists its files with their bytes').toBe(true);
  return files as readonly DeliveredFile[];
}

function fileAt(files: readonly DeliveredFile[], path: string): DeliveredFile | undefined {
  return files.find((entry) => entry.path === path);
}

describe('acceptance · a two-part requirement becomes a two-part delivery', () => {
  it('delivers the frontend, the python backend and the wiring that runs them', async () => {
    // The requirement carries a build cue, a web cue and a backend cue — the plan the CEO
    // composes is the delivery arc of the product, not a single narrow step.
    expect(requiredCapabilitiesFor(MANDATE)).toEqual(['implementation', 'frontend', 'backend']);

    const harness = await createAcceptanceHarness({ llmText: deterministicCognitionText });
    const instructed = await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: MANDATE,
      reason: 'board directive',
    });
    expect(instructed.status, JSON.stringify(instructed.failure)).toBe('accepted');

    await runToIdle(harness);

    const instances = harness.control.simulation.instanceStore.all();
    expect(instances).toHaveLength(1);
    const instance = instances[0];
    expect(instance?.status).toBe('completed');

    const tasks = harness.control.simulation.taskStore.all();
    expect(tasks.length).toBe(3);
    for (const task of tasks) {
      expect(task.status, `${task.title} did not complete`).toBe('completed');
    }

    // 1. One step per capability, and the step's *kind of work* travelled with the work: it is on
    //    the task record and (below) on the wake-up event that shaped the delivery.
    const byCapability = new Map(tasks.map((task) => [task.capability, task]));
    expect([...byCapability.keys()].sort()).toEqual(['backend', 'frontend', 'implementation']);
    expect(tasks.every((task) => task.assignment.assigneeEmployeeId === 'engineer-mike')).toBe(true);

    const frontendTask = byCapability.get('frontend');
    const backendTask = byCapability.get('backend');
    const implementationTask = byCapability.get('implementation');
    expect(frontendTask).toBeDefined();
    expect(backendTask).toBeDefined();
    expect(implementationTask).toBeDefined();
    if (frontendTask === undefined || backendTask === undefined || implementationTask === undefined) return;

    // 2. The frontend half: a playable SPA that posts to the service (and says so on the page).
    const frontendFiles = filesOf(frontendTask.result?.data ?? {});
    expect(frontendTask.result?.artifacts).toEqual(['client/index.html', 'client/README.md']);
    const client = fileAt(frontendFiles, 'client/index.html');
    expect(client).toBeDefined();
    expect(client?.content).toContain('<canvas id="board"');
    expect(client?.content).toContain('requestAnimationFrame');
    expect(client?.content).toContain('/api/scores');
    expect(client?.content).toContain('window.maoehScore');
    // It is the client of the same product, not of the seat's other capabilities.
    expect(client?.content).not.toContain('implementation/index.html');

    // 3. The backend half: a Python service that records every play and serves the ranking.
    const backendFiles = filesOf(backendTask.result?.data ?? {});
    expect(backendTask.result?.artifacts).toEqual(['server/app.py', 'server/README.md']);
    const service = fileAt(backendFiles, 'server/app.py');
    expect(service).toBeDefined();
    expect(service?.content).toContain('ThreadingHTTPServer');
    expect(service?.content).toContain('sqlite3');
    expect(service?.content).toContain('INSERT INTO plays');
    expect(service?.content).toContain('/api/scores');
    expect(service?.language).toBe('python');
    expect(backendTask.result?.data['stack']).toEqual(['Python 3', 'sqlite3', 'http.server']);

    // 4. The implementation half: one command that runs the product.
    const implementationFiles = filesOf(implementationTask.result?.data ?? {});
    expect(implementationTask.result?.artifacts).toEqual(['run.py', 'README.md']);
    const launcher = fileAt(implementationFiles, 'run.py');
    expect(launcher?.content).toContain('app.py');
    const readme = fileAt(implementationFiles, 'README.md');
    expect(readme?.content).toContain('client/index.html');
    expect(readme?.content).toContain('server/app.py');
    expect(readme?.content).toContain('python run.py');

    // 5. The two halves agree on the API without any shared file existing at delivery time: both
    //    were generated from the same requirement, so the client's calls are the service's routes.
    expect(client?.content).toContain('/api/scores');
    expect(service?.content).toContain('/api/scores');
    expect(service?.content).toContain('/api/health');

    // 6. The capability reached the executor on the event that woke it — this is the link the
    //    defect was missing, and it is on the log, not only in the task record.
    const events: readonly OrgEvent[] = await collectEvents(harness.control.simulation.eventStore);
    const carried = events
      .filter((event) => event.type === 'Task.Assigned')
      .map((event) => (event.payload as Readonly<Record<string, unknown>>)['capability']);
    expect(carried).toEqual(['implementation', 'frontend', 'backend']);
  });
});
