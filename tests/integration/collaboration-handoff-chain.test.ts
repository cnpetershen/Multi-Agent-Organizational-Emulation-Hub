import { describe, expect, it } from 'vitest';
import type { CorrelationId, OrgEvent } from '@maoeh/shared-types';
import type { LlmRequest } from '@maoeh/llm-gateway';
import type { ControlHarness } from '../helpers/control-fixtures';
import { collectEvents, createControlHarness } from '../helpers/control-fixtures';
import { validOutput } from '../helpers/cognition-fixtures';

/**
 * M3.1 · one real collaboration chain, end to end, on the real kernel.
 *
 * The mandate for this milestone is precise: "实现至少一条真实 Agent 消息通信与任务交接链路，
 * 验证接收方能够实际处理交接任务并反馈结果，保证事件可以完整追溯." This test is that claim.
 *
 * Nothing is stubbed below the cognition boundary: a real `Simulation`, the real `TaskService`,
 * the real `CommunicationService`, the real scheduler, real event store and the real control
 * plane. The only test double is the model's *text* output (a deterministic planner), which is the
 * same seam the production mock provider uses.
 *
 * The run:
 *
 *   operator injects a task → engineer seat
 *   engineer is instructed → sends a message to QA + asks QA to take the task   (Task.HandoffRequested)
 *   QA answers the message, accepts the handoff → task reassigned to QA          (Task.HandoffAccepted + Task.Assigned)
 *   QA starts and submits a real delivery
 *   the kernel's reactor settles the standalone task                             (Task.Completed)
 *   the handoff settles with that result                                         (Task.HandoffCompleted)
 *
 * Then: the trace walks causation, the message lifecycle shows sent→delivered→processed, the
 * legacy audit is clean, and a restart over the same log rebuilds all of it.
 */

const CHANNEL = 'company-future-ai-lab';

function inputEventOf(prompt: string): Readonly<Record<string, unknown>> {
  const start = prompt.indexOf('## Input event\n');
  const end = prompt.indexOf('\n\n## Required JSON schema', start);
  if (start < 0 || end < 0) return {};
  try {
    const parsed: unknown = JSON.parse(prompt.slice(start + '## Input event\n'.length, end).trim());
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Readonly<Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
}

function openTaskIdOf(prompt: string): string | null {
  const section = prompt.slice(0, prompt.indexOf('## Input event'));
  return /taskId=(task-[A-Za-z0-9_-]+)/.exec(section)?.[1] ?? null;
}

function noOp(reason: string): string {
  return validOutput({
    interpretation: reason,
    considerations: ['Nothing in my remit needs a side effect right now.'],
    conclusion: 'Acknowledge and stay available.',
    goal: 'remain available',
    doneWhen: 'the event is acknowledged',
    steps: [{ action: 'Reflect', args: {}, reasonRef: 0 }],
  });
}

/**
 * The deterministic planner. It reads the same prompt a live model reads and answers in the same
 * closed action space; every decision below is a real action the kernel plan executor implements.
 */
function collaborationScript(request: LlmRequest): string {
  const prompt = request.prompt;
  const event = inputEventOf(prompt);
  const type = String(event['type'] ?? '');
  const payload =
    typeof event['payload'] === 'object' && event['payload'] !== null
      ? (event['payload'] as Readonly<Record<string, unknown>>)
      : {};
  const selfName = /^Self: .* \[([^\]]+)\]$/m.exec(prompt)?.[1] ?? '';

  if (type === 'Control.AgentInstructed' && selfName === 'engineer-mike') {
    const taskId = openTaskIdOf(prompt);
    if (taskId === null) return noOp('The instruction names no open task.');
    return validOutput({
      interpretation: `The board asked me to hand task ${taskId} to QA and say why.`,
      considerations: [
        'QA owns verification; I cannot verify my own implementation.',
        'The handoff must be two-sided: QA accepts before the task moves.',
      ],
      conclusion: 'Message QA with the context and ask for the handoff in the same turn.',
      goal: `${taskId} is taken over by QA`,
      doneWhen: 'QA accepted the handoff and delivered the checklist',
      steps: [
        {
          action: 'SendMessage',
          args: {
            channelId: CHANNEL,
            recipientIds: ['qa-peter'],
            subject: 'Please take over the release checklist',
            body: `I am handing you task ${taskId}: QA owns the verification checklist and I cannot verify my own implementation. Please accept the handoff and deliver it.`,
            messageType: 'request',
            // A retried turn must not duplicate the request.
            dedupeKey: `handoff-msg:${taskId}`,
          },
          reasonRef: 0,
        },
        {
          action: 'HandoffTask',
          args: {
            taskId,
            toAgentId: 'qa-peter',
            reason: 'QA owns verification of implementation work',
            note: 'the checklist must cover build, smoke and approval steps',
          },
          reasonRef: 0,
        },
      ],
    });
  }

  if (type === 'Task.HandoffRequested') {
    const taskId = String(payload['taskId'] ?? '');
    const handoffId = String(payload['handoffId'] ?? '');
    return validOutput({
      interpretation: `The engineer asked me to take task ${taskId} through handoff ${handoffId}.`,
      considerations: [
        'The request is addressed to me by name.',
        'Accepting moves the task to me, so my delivery is the task result.',
      ],
      conclusion: 'Accept the handoff, start the task and submit the checklist.',
      goal: `${taskId} is delivered by QA`,
      doneWhen: 'the task carries my submitted checklist',
      steps: [
        {
          action: 'AcceptHandoff',
          args: { taskId, handoffId },
          reasonRef: 0,
        },
        { action: 'StartTask', args: { taskId }, reasonRef: 1 },
        {
          action: 'ProgressReport',
          args: {
            taskId,
            summary: 'Release checklist delivered by QA',
            data: { checklist: '1. build\n2. smoke\n3. approval' },
          },
          reasonRef: 1,
        },
      ],
    });
  }

  if (type === 'Communication.MessageSent') {
    const messageType = String(payload['messageType'] ?? '');
    const senderId = String(payload['senderId'] ?? '');
    if (messageType !== 'request') {
      return noOp('The message is informational; no reply is required.');
    }
    return validOutput({
      interpretation: `${senderId} asked me to take over a task.`,
      considerations: ['A request deserves an explicit answer on the same channel.'],
      conclusion: 'Answer, then act on the handoff request in the same cycle.',
      goal: 'the sender knows I took it',
      doneWhen: 'a response message is on the channel',
      steps: [
        {
          action: 'SendMessage',
          args: {
            channelId: CHANNEL,
            recipientIds: [senderId],
            subject: 're: release checklist',
            body: 'Accepted — I am taking the task and will submit the checklist.',
            messageType: 'response',
          },
          reasonRef: 0,
        },
      ],
    });
  }

  return noOp(`Event ${type} needs no side effect from ${selfName || 'me'}.`);
}

async function injectEngineerTask(h: ControlHarness): Promise<string> {
  const injected = await h.plane.control.execute(
    h.command('Organization.InjectTask', {
      targetType: 'organization',
      targetId: 'future-ai-lab',
      reason: 'M3.1 handoff chain',
      extra: {
        title: 'Ship the release checklist',
        goal: 'Write the release checklist with every verification step',
        requiredSkills: ['implementation'],
      },
    } as never),
  );
  expect(injected.status, JSON.stringify(injected.failure)).toBe('accepted');
  const taskId = h.plane.control.query.getTasks()[0]?.taskId ?? '';
  expect(taskId).not.toBe('');
  return taskId;
}

function eventOfType(events: readonly OrgEvent[], type: string): OrgEvent | undefined {
  return events.find((event) => event.type === type);
}

describe('M3.1 collaboration chain · message + task handoff + result', () => {
  it('runs the chain on the real kernel and keeps every link traceable', async () => {
    const h = await createControlHarness({ llmText: collaborationScript });
    const taskId = await injectEngineerTask(h);

    // The engineer is woken by the assignment but deliberately does not start: the operator's
    // instruction is what turns this into a handoff.
    await h.harness.run(1);
    const engineerTask = h.simulation.tasks.get(taskId);
    expect(engineerTask?.assignment.assigneeEmployeeId).toBe('engineer-mike');
    expect(engineerTask?.status).toBe('assigned');

    const instructed = await h.plane.control.execute(
      h.command('Agent.Instruct', {
        targetType: 'agent',
        targetId: 'engineer-mike',
        reason: 'avoid self-verification: hand the checklist to QA',
        extra: {
          instruction: `Hand task ${taskId} to QA — they own verification — and deliver it.`,
        },
      } as never),
    );
    expect(instructed.status, JSON.stringify(instructed.failure)).toBe('accepted');
    const instructionEventId = instructed.events[0] ?? '';

    // Let the whole chain settle (message → handoff → execution → settlement → follow-up turns).
    const results = await h.harness.run(8);
    const allEvents = await collectEvents(h.simulation.eventStore);

    // 1. The engineer really sent a message and really asked for the handoff.
    const message = eventOfType(allEvents, 'Communication.MessageSent');
    expect(message?.payload).toMatchObject({
      senderId: 'engineer-mike',
      recipientIds: ['qa-peter'],
      messageType: 'request',
      dedupeKey: `handoff-msg:${taskId}`,
    });
    const requested = eventOfType(allEvents, 'Task.HandoffRequested');
    expect(requested?.payload).toMatchObject({
      taskId,
      fromEmployeeId: 'engineer-mike',
      toEmployeeId: 'qa-peter',
      fromStatus: 'assigned',
    });
    // The ask is caused by the instruction that produced it.
    expect(requested?.causationId).toBe(instructionEventId);

    // 2. QA actually processed the handoff: accepted, reassigned, started, submitted.
    const accepted = eventOfType(allEvents, 'Task.HandoffAccepted');
    expect(accepted?.actorId).toBe('qa-peter');
    expect(accepted?.causationId).toBe(requested?.eventId);
    const reassigned = allEvents.find(
      (event) => event.type === 'Task.Assigned' && event.causationId === accepted?.eventId,
    );
    expect(reassigned?.payload).toMatchObject({
      assignment: { assigneeEmployeeId: 'qa-peter' },
      reason: expect.stringContaining('handoff'),
    });
    const submitted = allEvents.find(
      (event) =>
        event.type === 'Task.ProgressReported' &&
        (event.payload as Readonly<Record<string, unknown>>)['phase'] === 'submitted',
    );
    expect(submitted?.actorId).toBe('qa-peter');
    expect(submitted?.payload).toMatchObject({
      result: { producedBy: 'qa-peter', data: { checklist: expect.stringContaining('build') } },
    });

    // 3. The receiver's result really closed the task and really settled the handoff.
    const completed = eventOfType(allEvents, 'Task.Completed');
    expect(completed?.payload).toMatchObject({
      taskId,
      result: { producedBy: 'qa-peter', summary: 'Release checklist delivered by QA' },
    });
    const settled = eventOfType(allEvents, 'Task.HandoffCompleted');
    const requestedPayload = (requested?.payload ?? {}) as Readonly<Record<string, unknown>>;
    expect(settled?.causationId).toBe(completed?.eventId);
    expect(settled?.payload).toMatchObject({
      handoffId: requestedPayload['handoffId'],
      outcome: 'completed',
      resultSummary: 'Release checklist delivered by QA',
    });

    const finalTask = h.simulation.tasks.get(taskId);
    expect(finalTask).toMatchObject({
      status: 'completed',
      assignment: { assigneeEmployeeId: 'qa-peter' },
      handoff: { status: 'completed', outcome: 'completed' },
    });
    expect(finalTask?.result?.producedBy).toBe('qa-peter');

    // 4. Every recipient turn is represented, and the sender was told about the result.
    const turnEmployees = results.flatMap((result) => result.turns.map((turn) => turn.employeeId));
    expect(turnEmployees).toContain('engineer-mike');
    expect(turnEmployees).toContain('qa-peter');

    // 5. Message lifecycle: sent → delivered → processed, from the real services.
    const lifecycle = await h.plane.control.query.getMessageLifecycle();
    expect(lifecycle).toHaveLength(2); // the request and QA's answer
    const requestLifecycle = lifecycle.find(
      (entry) => entry.senderId === 'engineer-mike' && entry.recipients[0]?.recipientId === 'qa-peter',
    );
    expect(requestLifecycle?.recipients[0]).toMatchObject({
      state: 'processed',
      outcome: 'handled',
    });
    expect(requestLifecycle?.recipients[0]?.deliveredAtSim).not.toBeNull();

    // 6. The collaboration trace walks the whole chain and has no broken links.
    const trace = await h.plane.control.query.getCollaborationTrace();
    expect(trace.danglingCausation).toEqual([]);
    const taskTrace = trace.entries.filter((entry) => entry.taskId === taskId);
    expect(taskTrace.map((entry) => entry.type)).toEqual([
      'Task.Assigned',
      'Task.HandoffRequested',
      'Task.HandoffAccepted',
      'Task.Assigned',
      // `StartTask` on an assigned task accepts implicitly first — a real fact, so it is traced.
      'Task.Accepted',
      'Task.ProgressReported',
      'Task.HandoffCompleted',
    ]);
    // Every entry after the first is caused by an event that is itself in the trace.
    const ids = new Set(taskTrace.map((entry) => entry.eventId));
    for (const entry of taskTrace.slice(1)) {
      if (entry.causationId === null) continue;
      expect(
        ids.has(entry.causationId) || allEvents.some((event) => event.eventId === entry.causationId),
        `broken causation on ${entry.type}`,
      ).toBe(true);
    }

    // 7. The legacy audit has nothing to complain about on this chain.
    const audit = await h.plane.control.query.getLegacyWorkAudit();
    expect(audit.findings.filter((finding) => finding.taskId === taskId)).toEqual([]);

    // 8. Idempotency: re-sending with the same dedupe key is a no-op, not a second message.
    const resend = h.simulation.communication.sendMessage({
      actor: h.simulation.identity.actorContext('engineer-mike', 'corr-resend' as CorrelationId),
      senderEmployeeId: 'engineer-mike' as never,
      channelId: CHANNEL,
      recipientIds: ['qa-peter' as never],
      subject: 'Please take over the release checklist',
      body: 'duplicate send',
      messageType: 'request',
      simTime: h.simulation.scheduler.clock.simTime,
      dedupeKey: `handoff-msg:${taskId}`,
    });
    expect(resend.ok).toBe(true);
    if (resend.ok) {
      expect(resend.value.duplicate).toBe(true);
      expect(resend.value.message.messageId).toBe(
        (message?.payload as Readonly<Record<string, unknown>>)['messageId'],
      );
    }
    const afterResend = await h.plane.control.query.getMessageLifecycle();
    expect(afterResend).toHaveLength(2);
  });

  it('rebuilds the same chain, message state and trace after a restart', async () => {
    const h = await createControlHarness({ llmText: collaborationScript });
    const taskId = await injectEngineerTask(h);
    await h.harness.run(1);
    await h.plane.control.execute(
      h.command('Agent.Instruct', {
        targetType: 'agent',
        targetId: 'engineer-mike',
        reason: 'hand the checklist to QA',
        extra: { instruction: `Hand task ${taskId} to QA and deliver it.` },
      } as never),
    );
    await h.harness.run(8);

    const before = {
      task: h.simulation.tasks.get(taskId),
      deliveries: h.simulation.communication.getDeliveries().length,
      messages: h.simulation.communication.getMessages().length,
      processing: h.simulation.communication.getProcessing().length,
      trace: await h.plane.control.query.getCollaborationTrace(),
      lifecycle: await h.plane.control.query.getMessageLifecycle(),
    };
    expect(before.task?.status).toBe('completed');
    expect(before.deliveries).toBeGreaterThan(0);
    expect(before.processing).toBeGreaterThan(0);

    // Restart over the same event store: the runtime rebuilds tasks, messages, deliveries,
    // processing marks and the handoff from the log alone.
    const restarted = await createControlHarness({ eventStore: h.simulation.eventStore });
    const after = {
      task: restarted.simulation.tasks.get(taskId),
      deliveries: restarted.simulation.communication.getDeliveries().length,
      messages: restarted.simulation.communication.getMessages().length,
      processing: restarted.simulation.communication.getProcessing().length,
      trace: await restarted.plane.control.query.getCollaborationTrace(),
      lifecycle: await restarted.plane.control.query.getMessageLifecycle(),
    };
    expect(after.task).toMatchObject({
      status: 'completed',
      assignment: { assigneeEmployeeId: 'qa-peter' },
      handoff: { status: 'completed', outcome: 'completed' },
    });
    expect(after.task?.result?.producedBy).toBe('qa-peter');
    expect(after.messages).toBe(before.messages);
    expect(after.deliveries).toBe(before.deliveries);
    expect(after.processing).toBe(before.processing);
    // The projection is replay-equivalent: same chain, same message states, no broken links.
    expect(after.trace.entries).toEqual(before.trace.entries);
    expect(after.lifecycle).toEqual(before.lifecycle);
    expect(after.trace.danglingCausation).toEqual([]);
  });
});
