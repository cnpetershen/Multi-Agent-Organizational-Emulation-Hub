import { describe, expect, it } from 'vitest';
import { buildWorkBrief, type BriefFormValue, type CommandContext } from '../../../apps/web/src/commands';
import { briefNeedsAttention, briefState, selectBrief, type Row } from '../../../apps/web/src/derive';

/**
 * M1.4 acceptance 3 (`任务书 → 各项 → 状态`) lives or dies on two pure seams. `buildWorkBrief`
 * is the only place the brief form is turned into the one command the Control Plane accepts —
 * if it ever emits a `priority` or `dueAtSim` the API would refuse, or drops the operator's
 * reason, the whole "one screen from brief to status" path stalls at the first step. On the
 * read side, `briefState` decides the pill for a whole brief from its own counts, so a brief
 * that still needs a human can never be shown as 完成. Both are pinned here.
 */

const ctx: CommandContext = { companyId: 'peter-ai-lab', simTime: 42 };

const form = (overrides: Partial<BriefFormValue> = {}): BriefFormValue => ({
  title: 'Ship the changelog',
  goal: 'Publish it to the docs site',
  context: 'Draft from the last three merges',
  keys: 'changelog.md\n/whats-new',
  reason: 'Quarterly release',
  priority: '',
  dueAtSim: '',
  ...overrides,
});

describe('work brief drafting', () => {
  it('trims every field and splits the acceptance keys on newlines and commas', () => {
    const draft = buildWorkBrief(form({ title: '  Ship the changelog  ', keys: ' a , b\nc ,,  \nd ' }));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.brief.title).toBe('Ship the changelog');
    expect(draft.brief.goal).toBe('Publish it to the docs site');
    expect(draft.brief.context).toBe('Draft from the last three merges');
    expect(draft.brief.verificationKeys).toEqual(['a', 'b', 'c', 'd']);
    expect(draft.reason).toBe('Quarterly release');
  });

  it('leaves the optional numbers out of the command when they are blank', () => {
    const draft = buildWorkBrief(form());
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.brief.priority).toBeUndefined();
    expect(draft.brief.dueAtSim).toBeUndefined();
  });

  it('keeps the optional numbers when they parse, including a zero due time', () => {
    const draft = buildWorkBrief(form({ priority: ' 7 ', dueAtSim: '0' }));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.brief.priority).toBe(7);
    expect(draft.brief.dueAtSim).toBe(0);
  });

  it('names the field that is not good enough yet, in the order the form asks', () => {
    expect(buildWorkBrief(form({ title: '   ', goal: '' })).ok === false && buildWorkBrief(form({ title: '   ', goal: '' })).problem).toBe('title');
    expect(buildWorkBrief(form({ keys: ' ,\n  ' })).ok === false && buildWorkBrief(form({ keys: ' ,\n  ' })).problem).toBe('keys');
    expect(buildWorkBrief(form({ reason: '  ' })).ok === false && buildWorkBrief(form({ reason: '  ' })).problem).toBe('reason');
  });

  it('refuses a priority or a due time the Control Plane would reject', () => {
    const priority = buildWorkBrief(form({ priority: '0' }));
    expect(priority.ok === false && priority.problem).toBe('priority');
    expect(buildWorkBrief(form({ priority: '10' })).ok).toBe(false);
    expect(buildWorkBrief(form({ priority: 'high' })).ok).toBe(false);
    const due = buildWorkBrief(form({ dueAtSim: '-1' }));
    expect(due.ok === false && due.problem).toBe('due');
    expect(buildWorkBrief(form({ dueAtSim: 'soon' })).ok).toBe(false);
  });

  it('never emits a command the API would refuse', () => {
    const draft = buildWorkBrief(form({ priority: '1', dueAtSim: '9' }));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const command = { ...draft.brief, reason: draft.reason };
    expect(Number.isInteger(command.priority)).toBe(true);
    expect(Number.isInteger(command.dueAtSim)).toBe(true);
    expect(command.title.length).toBeLessThanOrEqual(200);
    expect(command.verificationKeys.every((key) => key.length <= 64)).toBe(true);
    expect(ctx.companyId).toBe('peter-ai-lab');
  });
});

const brief = (counts: Row): Row => ({ commandId: 'cmd-1', counts });

describe('work brief status', () => {
  it('is pending until the read model reports any work item', () => {
    const state = briefState(brief({}));
    expect(state.kind).toBe('pending');
    expect(state.pillValue).toBe('idle');
    expect(briefState(brief({ total: 0, completed: 0 })).kind).toBe('pending');
  });

  it('needs attention the moment one item is blocked or rejected, whatever else finished', () => {
    const blocked = briefState(brief({ total: 3, completed: 2, blocked: 1 }));
    expect(blocked.kind).toBe('attention');
    expect(blocked.pillValue).toBe('blocked');
    const rejected = briefState(brief({ total: 3, completed: 2, rejected: 1 }));
    expect(rejected.kind).toBe('attention');
    expect(briefNeedsAttention(brief({ total: 1, rejected: 1 }))).toBe(true);
    expect(briefNeedsAttention(brief({ total: 2, completed: 1 }))).toBe(false);
  });

  it('is completed only when every item is completed, and running in between', () => {
    expect(briefState(brief({ total: 3, completed: 3 })).kind).toBe('completed');
    expect(briefState(brief({ total: 3, completed: 3 })).pillValue).toBe('completed');
    expect(briefState(brief({ total: 3, completed: 2 })).kind).toBe('running');
    expect(briefState(brief({ total: 3, completed: 2 })).pillValue).toBe('active');
  });

  it('picks the brief this console just filed by its own command id', () => {
    const rows: readonly Row[] = [{ commandId: 'cmd-0', counts: {} }, { commandId: 'cmd-1', counts: { total: 2 } }];
    expect(selectBrief(rows, 'cmd-1')).not.toBeNull();
    expect(selectBrief(rows, 'cmd-2')).toBeNull();
    expect(selectBrief(rows, '')).toBeNull();
    expect(selectBrief([], 'cmd-1')).toBeNull();
  });
});
