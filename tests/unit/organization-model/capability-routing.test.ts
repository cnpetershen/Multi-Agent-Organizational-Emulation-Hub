import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_VOCABULARY,
  CORE_CAPABILITIES,
  analyzeCapabilities,
  buildRuntimePosition,
  requiredCapabilitiesFor,
  resolveCapabilityAssignments,
} from '@maoeh/organization-model';
import type { Organization } from '@maoeh/organization-model';
import { loadSeedOrganization } from '../../helpers/simulation-fixtures';
import { createMemoryOrganizationReader } from '../../helpers/organization-readers';
import { loadOrganization } from '@maoeh/organization-model';

/**
 * Capability → position routing — the rule "the CEO calls a matching seat" is decided by
 * `Position.capabilities`, never by a position's name or by a hardcoded title list.
 *
 * Three properties are pinned here:
 *   1. analysis — bilingual goal text yields capability ids, and an unclear mandate falls
 *      back to the core delivery chain instead of producing nothing;
 *   2. resolution — a capability maps to a *declaring* seat, prefers a staffed seat, and a
 *      vacant seat escalates to the nearest staffed manager; a capability nobody declares
 *      resolves to nothing (no invented seats);
 *   3. creation — a typed-in seat ("Game Developer") joins an existing department with the
 *      department head as its manager, and refuses unknown departments / duplicate ids.
 */

const seed = loadSeedOrganization();

function load(files: Record<string, string>): Organization {
  const result = loadOrganization(createMemoryOrganizationReader(files));
  if (!result.ok) {
    throw new Error(
      result.error.issues.map((issue) => `${issue.source}: ${issue.reason}`).join('\n'),
    );
  }
  return result.value;
}

/** A tiny company: a staffed CEO, one department whose two seats are both vacant. */
function vacantSeatOrg(): Organization {
  return load({
    'company.yaml': 'id: acme\nname: Acme\n',
    'departments/lab.yaml': 'id: lab\nname: Lab\nhead_position: lab-head\n',
    'positions/ceo.yaml': 'id: ceo\ntitle: Chief Executive Officer\n',
    'positions/lab-head.yaml':
      'id: lab-head\ntitle: Lab Lead\ndepartment: lab\nreports_to: ceo\ncapabilities:\n  - implementation\n',
    'positions/dev.yaml':
      'id: dev\ntitle: Teleporter\ndepartment: lab\nreports_to: lab-head\ncapabilities:\n  - implementation\n',
    'positions/wizard.yaml': 'id: wizard\ntitle: Implementation Wizard\ndepartment: lab\nreports_to: lab-head\n',
    'employees/alex.yaml': 'id: alex\nname: Alex\nposition: ceo\n',
  });
}

describe('capability vocabulary (bilingual analysis)', () => {
  it('matches English cues on word boundaries and Chinese cues by substring', () => {
    expect(analyzeCapabilities('Develop a snake game and test it')).toEqual([
      'implementation',
      'testing',
    ]);
    expect(analyzeCapabilities('开发贪吃蛇 Demo')).toEqual(['implementation']);
    expect(analyzeCapabilities('起草 PRD 并做需求分析')).toEqual(['product_requirement']);
  });

  it('recognises the frontend/backend specializations in both languages', () => {
    // The acceptance sentence: "开发一个官网" is implementation work that is frontend-specific.
    expect(analyzeCapabilities('开发一个官网')).toEqual(['implementation', 'frontend']);
    expect(requiredCapabilitiesFor('开发一个官网')).toEqual(['implementation', 'frontend']);
    expect(analyzeCapabilities('做前端页面')).toEqual(['frontend']);
    // "搭建" is a build verb: building a backend service is implementation work that is
    // backend-specific, exactly like "开发一个官网" is implementation + frontend.
    expect(analyzeCapabilities('搭建后端服务')).toEqual(['implementation', 'backend']);
    // Order is the vocabulary's, never the sentence's.
    expect(analyzeCapabilities('Build a marketing website with a REST API')).toEqual([
      'implementation',
      'frontend',
      'backend',
      'marketing',
    ]);
  });

  it('stacks a specialization onto its parent delivery capability (回归：贪吃蛇请求)', () => {
    // Reported symptom: the same game idea resolved differently by wording, and the phrasing
    // without the literal word "demo" collapsed to a single frontend step — so the generated
    // workflow never scheduled the implementation work the goal plainly needs.
    expect(requiredCapabilitiesFor('贪吃蛇小游戏\n做一个Web 端的贪吃蛇小游戏')).toEqual([
      'implementation',
      'frontend',
    ]);
    // "做一个" is a build verb on its own, with no other cue in the text.
    expect(analyzeCapabilities('做一个贪吃蛇')).toEqual(['implementation']);
    // A specialization implies its parent even when the text never names implementation.
    expect(requiredCapabilitiesFor('做前端页面')).toEqual(['implementation', 'frontend']);
    expect(requiredCapabilitiesFor('搭建后端服务')).toEqual(['implementation', 'backend']);
  });

  it('never returns an empty plan: an unclear mandate is the core delivery chain', () => {
    expect(requiredCapabilitiesFor('Own the churn problem.')).toEqual(CORE_CAPABILITIES);
    expect(CORE_CAPABILITIES).toEqual([
      'product_requirement',
      'technical_design',
      'implementation',
      'testing',
    ]);
  });

  it('gives every vocabulary entry bilingual hints', () => {
    for (const entry of CAPABILITY_VOCABULARY) {
      const hasLatin = entry.hints.some((hint) => /[a-z]/i.test(hint));
      const hasCjk = entry.hints.some((hint) => /[一-鿿]/.test(hint));
      expect(hasLatin, `${entry.id} latin hints`).toBe(true);
      expect(hasCjk, `${entry.id} cjk hints`).toBe(true);
    }
  });
});

describe('capability → position resolution', () => {
  it('routes every core capability to a declaring seat in the seed', () => {
    const assignments = resolveCapabilityAssignments(seed, CORE_CAPABILITIES);
    expect(assignments.map((assignment) => assignment.capability)).toEqual([
      'product_requirement',
      'technical_design',
      'implementation',
      'testing',
    ]);
    for (const assignment of assignments) {
      const seat = seed.positions.find((position) => String(position.id) === assignment.positionId);
      expect(seat, assignment.capability).toBeDefined();
      expect(seat?.capabilities ?? []).toContain(assignment.capability);
    }
  });

  it('escalates a vacant seat to the nearest staffed manager up the chain', () => {
    const org = vacantSeatOrg();
    const vacant = resolveCapabilityAssignments(org, ['implementation']);
    expect(vacant).toHaveLength(1);
    expect(vacant[0]?.positionId).toBe('ceo');
    // The declaring seat closest to a staffed manager wins the escalation race (lab-head is
    // one hop from the CEO, dev is two).
    expect(vacant[0]?.matchedPositionId).toBe('lab-head');
    expect(vacant[0]?.escalated).toBe(true);
  });

  it('prefers the staffed seat itself once someone sits in it', () => {
    const org = vacantSeatOrg();
    org.employees.push({
      id: 'dora' as Organization['employees'][number]['id'],
      companyId: org.company.id,
      positionId: 'dev' as Organization['employees'][number]['positionId'],
      name: 'Dora',
      kind: 'agent',
      status: 'active',
    });
    const staffed = resolveCapabilityAssignments(org, ['implementation']);
    expect(staffed[0]?.positionId).toBe('dev');
    expect(staffed[0]?.escalated).toBe(false);
  });

  it('never matches by position title', () => {
    const org = vacantSeatOrg();
    // "Implementation Wizard" *sounds* right but declares no capability: not a candidate.
    const assignments = resolveCapabilityAssignments(org, ['implementation']);
    expect(assignments.map((assignment) => assignment.positionId)).not.toContain('wizard');
    // A capability nobody declares resolves to nothing instead of inventing a seat.
    expect(resolveCapabilityAssignments(org, ['teleportation'])).toEqual([]);
  });

  it('never routes the core delivery chain to the seat the mandate came from', () => {
    // The seed's CEO both declares `product_requirement` and is the seat the operator instructs.
    // Routing must still answer with the seat that *does* that work, never the apex that
    // dispatched the mandate.
    const assignments = resolveCapabilityAssignments(seed, CORE_CAPABILITIES, {
      excludeSeatIds: ['ceo'],
    });
    expect(assignments.map((assignment) => assignment.capability)).toEqual([...CORE_CAPABILITIES]);
    for (const assignment of assignments) {
      expect(assignment.positionId, assignment.capability).not.toBe('ceo');
    }
    expect(
      assignments.find((assignment) => assignment.capability === 'product_requirement')?.positionId,
    ).toBe('product-manager');
  });

  it('keeps the seat that composes a plan out of the plan\'s own assignments', () => {
    // The seat that decomposes a mandate and hands the work out does not then execute its own
    // dispatch — "the CEO breaks the task book down and passes it to the seats that execute",
    // expressed as routing rather than as a promise.
    const org = vacantSeatOrg();
    // Baseline: with nobody excluded the vacant seats escalate up to the staffed CEO.
    expect(resolveCapabilityAssignments(org, ['implementation'])[0]?.positionId).toBe('ceo');
    // Excluding the dispatcher means the work has no seat left to go to, and it is *omitted*
    // rather than silently handed back to the seat that just dispatched it.
    expect(
      resolveCapabilityAssignments(org, ['implementation'], { excludeSeatIds: ['ceo'] }),
    ).toEqual([]);
  });

  it('still routes a capability to the dispatcher\'s seat when someone else provides it', () => {
    const org = vacantSeatOrg();
    org.employees.push({
      id: 'dora' as Organization['employees'][number]['id'],
      companyId: org.company.id,
      positionId: 'dev' as Organization['employees'][number]['positionId'],
      name: 'Dora',
      kind: 'agent',
      status: 'active',
    });
    const assignments = resolveCapabilityAssignments(org, ['implementation'], {
      excludeSeatIds: ['ceo'],
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.positionId).toBe('dev');
  });
});

describe('runtime position creation (typed-in seats)', () => {
  it('adds a seat under the department with the head as its default manager', () => {
    const org = vacantSeatOrg();
    const built = buildRuntimePosition(org, {
      positionId: 'game-developer',
      title: 'Game Developer',
      departmentId: 'lab',
      capabilities: [' Implementation ', 'IMPLEMENTATION', 'testing'],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('expected success');
    expect(built.value.reportsToPositionId).toBe('lab-head');
    expect(built.value.departmentId).toBe('lab');
    expect(built.value.capabilities).toEqual(['implementation', 'testing']);
    expect(built.value.title).toBe('Game Developer');
  });

  it('refuses an unknown department', () => {
    const built = buildRuntimePosition(vacantSeatOrg(), {
      positionId: 'ghost-seat',
      title: 'Ghost',
      departmentId: 'nowhere',
    });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('expected failure');
    expect(built.error.code).toBe('unknown_department');
  });

  it('refuses a duplicate position id', () => {
    const built = buildRuntimePosition(vacantSeatOrg(), {
      positionId: 'dev',
      title: 'Copy',
      departmentId: 'lab',
    });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('expected failure');
    expect(built.error.code).toBe('duplicate_position');
  });

  it('honours an explicit manager over the department head', () => {
    const built = buildRuntimePosition(vacantSeatOrg(), {
      positionId: 'dev-two',
      title: 'Developer Two',
      departmentId: 'lab',
      reportsToPositionId: 'dev',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('expected success');
    expect(built.value.reportsToPositionId).toBe('dev');
  });
});
