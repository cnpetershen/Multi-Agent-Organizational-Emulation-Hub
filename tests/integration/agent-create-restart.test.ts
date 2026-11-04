import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EmployeeId, SimTime } from '@maoeh/shared-types';
import type { AgentCreateCommand } from '@maoeh/organization-control';
import { createComposedRuntime } from '../../apps/api/src/composition';

/**
 * Regression for the operator report "我创建的 agent 经过重启后都不见了".
 *
 * The console is persistent by default now, and the durability boundary is the **event log**:
 * `Agent.Create` writes `Control.AgentCreated`, and a boot replays the log — so the agent, its
 * position and its reporting line all come back, while the company is still formed exactly once.
 *
 * The three cases below pin all of that, including the in-memory mode, so the old behaviour
 * cannot quietly return.
 */

const COMPANY = 'future-ai-lab';
const sim = (minutes: number): SimTime => minutes as SimTime;

function freshEventLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'maoeh-restart-')), 'events.jsonl');
}

function createAgentCommand(
  commandId: string,
  input: {
    employeeId: string;
    name: string;
    positionId: string;
    newPosition?: {
      departmentId: string;
      title: string;
      capabilities: readonly string[];
    };
  },
): AgentCreateCommand {
  return {
    commandId,
    commandType: 'Agent.Create',
    actor: {
      operatorId: 'ceo-alex' as EmployeeId,
      displayName: 'Alex',
      positionId: 'ceo',
      kind: 'human',
    },
    target: { targetType: 'organization', targetId: COMPANY },
    reason: 'hired from the console',
    correlationId: commandId,
    causationId: null,
    createdAtSim: sim(0),
    employeeId: input.employeeId,
    name: input.name,
    positionId: input.positionId,
    responsibilities: ['product_roadmap'],
    ...(input.newPosition === undefined ? {} : { newPosition: input.newPosition }),
  };
}

const agentIds = (snapshot: { readonly agents: readonly { readonly employeeId: string }[] }): string[] =>
  snapshot.agents.map((agent) => agent.employeeId);

describe('M1.3 事件日志重启：控制台创建的 Agent 不会因重启丢失', () => {
  it('Agent.Create 落进事件日志；用同一个日志重启后员工、岗位与汇报线都在', async () => {
    const path = freshEventLog();

    const first = await createComposedRuntime({ eventLogPath: path });
    const created = await first.api.control.execute(
      createAgentCommand('restart-cmd-1', {
        employeeId: 'pm-priya',
        name: 'Priya',
        positionId: 'product-manager',
      }),
    );
    expect(created.status).toBe('accepted');

    const before = await first.api.query.getOrganizationSnapshot();
    expect(agentIds(before)).toContain('pm-priya');
    expect(before.agents.find((agent) => agent.employeeId === 'pm-priya')?.managerEmployeeId).toBe('ceo-alex');
    expect(
      before.positions.find((position) => position.positionId === 'product-manager')?.employeeIds,
    ).toEqual(['pm-bona', 'pm-priya']);

    // The durability is at the log level, not in a private snapshot file.
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const types = lines.map((line) => (JSON.parse(line) as { readonly type: string }).type);
    expect(types).toContain('Control.AgentCreated');

    const restarted = await createComposedRuntime({ eventLogPath: path });
    const after = await restarted.api.query.getOrganizationSnapshot();
    const restored = after.agents.find((agent) => agent.employeeId === 'pm-priya');
    expect(restored).toBeDefined();
    expect(restored?.name).toBe('Priya');
    expect(restored?.positionId).toBe('product-manager');
    expect(restored?.status).toBe('active');
    expect(restored?.lifecycle).toBe('active');
    expect(restored?.managerEmployeeId).toBe('ceo-alex');
    expect(
      after.positions.find((position) => position.positionId === 'product-manager')?.employeeIds,
    ).toEqual(['pm-bona', 'pm-priya']);

    // 公司只组建一次：重启不会重复开频道（否则通讯会从两条流开始分叉）。
    const channels = restarted.simulation.communication
      .getChannels()
      .filter((channel) => channel.channelId === `company-${COMPANY}`);
    expect(channels).toHaveLength(1);
  });

  it('归档也是事件：重启后被归档的 Agent 仍然是归档态，不会被种子复活', async () => {
    const path = freshEventLog();

    const first = await createComposedRuntime({ eventLogPath: path });
    await first.api.control.execute(
      createAgentCommand('restart-cmd-2', { employeeId: 'qa-ken', name: 'Ken', positionId: 'qa' }),
    );
    const archived = await first.api.control.execute({
      commandId: 'restart-cmd-3',
      commandType: 'Agent.Archive',
      actor: { operatorId: 'ceo-alex' as EmployeeId, displayName: 'Alex', positionId: 'ceo', kind: 'human' },
      target: { targetType: 'agent', targetId: 'qa-ken' },
      reason: 'role retired',
      correlationId: 'restart-cmd-3',
      causationId: null,
      createdAtSim: sim(0),
    });
    expect(archived.status).toBe('accepted');

    const restarted = await createComposedRuntime({ eventLogPath: path });
    const snapshot = await restarted.api.query.getOrganizationSnapshot();
    expect(snapshot.agents.find((agent) => agent.employeeId === 'qa-ken')?.lifecycle).toBe('archived');
  });

  it('打字新建的职位也是组织状态：创建与重启都在，能力标签原样回来', async () => {
    const path = freshEventLog();

    const first = await createComposedRuntime({ eventLogPath: path });
    const created = await first.api.control.execute(
      createAgentCommand('restart-cmd-5', {
        employeeId: 'game-dev-dora',
        name: 'Dora',
        positionId: 'game-developer',
        newPosition: {
          departmentId: 'engineering',
          title: 'Game Developer',
          capabilities: ['implementation'],
        },
      }),
    );
    expect(created.status).toBe('accepted');

    const before = await first.api.query.getOrganizationSnapshot();
    const seat = before.positions.find((position) => position.positionId === 'game-developer');
    expect(seat).toBeDefined();
    expect(seat?.title).toBe('Game Developer');
    expect(seat?.departmentId).toBe('engineering');
    expect(seat?.capabilities).toEqual(['implementation']);
    expect(seat?.employeeIds).toEqual(['game-dev-dora']);
    // 默认挂到部门负责人（engineering 的 head 是 cto）下面。
    expect(
      before.agents.find((agent) => agent.employeeId === 'game-dev-dora')?.managerEmployeeId,
    ).toBe('cto-john');

    const restarted = await createComposedRuntime({ eventLogPath: path });
    const after = await restarted.api.query.getOrganizationSnapshot();
    const restoredSeat = after.positions.find(
      (position) => position.positionId === 'game-developer',
    );
    expect(restoredSeat?.title).toBe('Game Developer');
    expect(restoredSeat?.capabilities).toEqual(['implementation']);
    expect(restoredSeat?.employeeIds).toEqual(['game-dev-dora']);
    const restoredAgent = after.agents.find((agent) => agent.employeeId === 'game-dev-dora');
    expect(restoredAgent?.positionId).toBe('game-developer');
    expect(restoredAgent?.managerEmployeeId).toBe('cto-john');
  });

  it('不配日志（in-memory）时重启就回到种子 —— 旧行为仍然可复现，且只发生在这种模式下', async () => {
    const first = await createComposedRuntime({ eventLogPath: null });
    await first.api.control.execute(
      createAgentCommand('restart-cmd-4', { employeeId: 'pm-priya', name: 'Priya', positionId: 'product-manager' }),
    );
    expect(agentIds(await first.api.query.getOrganizationSnapshot())).toContain('pm-priya');

    const restarted = await createComposedRuntime({ eventLogPath: null });
    const after = await restarted.api.query.getOrganizationSnapshot();
    expect(agentIds(after)).not.toContain('pm-priya');
    expect(agentIds(after)).toEqual([
      'ceo-alex',
      'cto-john',
      'engineer-mike',
      'marketing-jack',
      'pm-bona',
      'qa-peter',
    ]);
  });
});
