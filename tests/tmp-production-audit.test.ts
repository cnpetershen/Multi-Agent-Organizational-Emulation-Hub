import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'vitest';
import type { OrgEvent, SimTime } from '@maoeh/shared-types';
import { applyTaskEvent } from '@maoeh/task-system';
import type { Task } from '@maoeh/task-system';
import { auditLegacyWork, legacyRepairPlan } from '@maoeh/organization-control';
import { loadSeedOrganization } from './helpers/simulation-fixtures';

/**
 * TEMPORARY, local-state-only tool: produce the M3.0 audit of the running production company's
 * event log. Not committed; deleted after producing `docs/competition/M3_0_LEGACY_AUDIT.md`.
 */
describe('temporary production audit', () => {
  it('writes the report', () => {
    const logPath = join(
      process.env['LOCALAPPDATA'] ?? '',
      'maoeh',
      'future-ai-lab',
      'peter-ai-lab',
      'events.jsonl',
    );
    const lines = readFileSync(logPath, 'utf8').split('\n');
    const events: OrgEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as OrgEvent);
      } catch {
        // a partially written tail line is not an event
      }
    }
    const groups = new Map<string, OrgEvent[]>();
    for (const event of events) {
      if (!event.type.startsWith('Task.')) continue;
      const payload = event.payload as Record<string, unknown>;
      const taskId = typeof payload['taskId'] === 'string' ? payload['taskId'] : null;
      if (taskId === null) continue;
      const list = groups.get(taskId) ?? [];
      list.push(event);
      groups.set(taskId, list);
    }
    const tasks: Task[] = [];
    for (const [, group] of groups) {
      let task: Task | null = null;
      for (const event of group) task = applyTaskEvent(task, event);
      if (task !== null) tasks.push(task);
    }
    const report = auditLegacyWork({
      tasks,
      events,
      organization: loadSeedOrganization(),
      simTime: events.reduce((max, event) => Math.max(max, Number(event.occurredAtSim)), 0) as SimTime,
    });
    const out = {
      logPath,
      eventCount: events.length,
      taskCount: tasks.length,
      report,
      repairPlan: legacyRepairPlan(report),
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        assignee: task.assignment.assigneeEmployeeId,
        instance: task.workflowInstanceId,
        created: Number(task.createdAtSim),
        completed: task.completedAtSim === null ? null : Number(task.completedAtSim),
        dataKeys: task.result === null ? [] : Object.keys(task.result.data),
        requiredKeys: task.verification?.requiredOutputKeys ?? [],
      })),
    };
    writeFileSync(join(tmpdir(), 'maoeh-production-audit.json'), JSON.stringify(out, null, 2));
  });
});
