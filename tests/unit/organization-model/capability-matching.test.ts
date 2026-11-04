import { describe, expect, it } from 'vitest';
import type { EmployeeId } from '@maoeh/shared-types';
import {
  CAPABILITY_MATCH_SCORE,
  DEPARTMENT_MATCH_SCORE,
  bestCapabilityMatch,
  buildCapabilityProfiles,
  loadOrganization,
  matchCapabilityCandidates,
} from '@maoeh/organization-model';
import type { Organization } from '@maoeh/organization-model';
import { createMemoryOrganizationReader } from '../../helpers/organization-readers';
import { loadSeedOrganization } from '../../helpers/simulation-fixtures';

/**
 * Capability → candidate matching (M1.6): "this work needs `implementation`; who can do it,
 * and why is *this* person the answer?".
 *
 * The matcher is a pure function of the organization plus the requirement — no clock, no
 * randomness, no LLM — so a delegation decision can always be explained after the fact:
 *   1. profiles — one derived record per employee, ordered by employee id, carrying only the
 *      capabilities their own seat declares (no invented skills);
 *   2. candidates — the holders of the seats that declare the requirement (escalating a vacant
 *      declaring seat to its nearest staffed manager), ranked by coverage, then department, then
 *      seat seniority, then employee id;
 *   3. exclusions — an empty requirement, an undeclared capability and an employment that
 *      cannot take work all match nobody instead of guessing.
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

/**
 * A tiny company where two seats declare `implementation`, two declare `testing`, and the CEO
 * declares both — the shape needed to show coverage outranking department and seniority.
 */
function capabilityOrg(doraStatus = 'active'): Organization {
  return load({
    'company.yaml': 'id: acme\nname: Acme\n',
    'departments/lab.yaml': 'id: lab\nname: Lab\n',
    'positions/ceo.yaml':
      'id: ceo\ntitle: Chief Executive Officer\nauthority_level: 5\ncapabilities:\n  - implementation\n  - testing\n',
    'positions/dev.yaml':
      'id: dev\ntitle: Software Engineer\ndepartment: lab\nauthority_level: 2\nreports_to: ceo\ncapabilities:\n  - implementation\n',
    'positions/qa.yaml':
      'id: qa\ntitle: QA Engineer\ndepartment: lab\nauthority_level: 2\nreports_to: ceo\ncapabilities:\n  - testing\n',
    'employees/alex.yaml': 'id: alex\nname: Alex\nposition: ceo\n',
    'employees/dora.yaml': `id: dora\nname: Dora\nposition: dev\nstatus: ${doraStatus}\n`,
    'employees/ron.yaml': 'id: ron\nname: Ron\nposition: qa\n',
  });
}

/** Two vacant seats declare `implementation`; only the CEO is staffed. */
function vacantSeatOrg(): Organization {
  return load({
    'company.yaml': 'id: acme\nname: Acme\n',
    'departments/lab.yaml': 'id: lab\nname: Lab\nhead_position: lab-head\n',
    'positions/ceo.yaml': 'id: ceo\ntitle: Chief Executive Officer\n',
    'positions/lab-head.yaml':
      'id: lab-head\ntitle: Lab Lead\ndepartment: lab\nreports_to: ceo\ncapabilities:\n  - implementation\n',
    'positions/dev.yaml':
      'id: dev\ntitle: Teleporter\ndepartment: lab\nreports_to: lab-head\ncapabilities:\n  - implementation\n',
    'employees/alex.yaml': 'id: alex\nname: Alex\nposition: ceo\n',
  });
}

describe('capability profiles (derived, never stored)', () => {
  it('profiles every employee from their own seat in a deterministic employee-id order', () => {
    const profiles = buildCapabilityProfiles(seed);
    expect(profiles.map((profile) => String(profile.employeeId))).toEqual([
      'ceo-alex',
      'cto-john',
      'engineer-mike',
      'marketing-jack',
      'pm-bona',
      'qa-peter',
    ]);

    const mike = profiles.find((profile) => String(profile.employeeId) === 'engineer-mike');
    expect(mike).toMatchObject({
      positionId: 'engineer',
      positionTitle: 'Software Engineer',
      departmentId: 'engineering',
      // The seat owns the delivery arc plus both specializations; the person brings both too.
      capabilities: ['implementation', 'frontend', 'backend'],
      expertise: ['typescript', 'react', 'node', 'frontend', 'backend'],
      seniority: 2,
      available: true,
    });

    // Same organization in, same list out — deterministic matching starts here.
    expect(buildCapabilityProfiles(seed)).toEqual(profiles);
  });

  it('carries the person\'s own expertise separately from the seat\'s capabilities', () => {
    const ceo = buildCapabilityProfiles(seed).find(
      (profile) => String(profile.employeeId) === 'ceo-alex',
    );
    // A CEO seat declares `product_requirement`; the person is specialized in strategy/organization.
    expect(ceo?.capabilities).toEqual(['product_requirement']);
    expect(ceo?.expertise).toEqual(['strategy', 'org_design', 'capital_allocation']);
    // Nobody declared `typescript` on a seat: it only exists as a person-level specialization.
    const ownerOfTypescript = buildCapabilityProfiles(seed).filter((profile) =>
      profile.expertise.includes('typescript'),
    );
    expect(ownerOfTypescript.map((profile) => String(profile.employeeId))).toEqual([
      'engineer-mike',
    ]);
  });

  it('never invents a capability the seat does not declare', () => {
    const ceo = buildCapabilityProfiles(seed).find(
      (profile) => String(profile.employeeId) === 'ceo-alex',
    );
    // "Chief Executive Officer" sounds like it could do anything; the seat says otherwise.
    expect(ceo?.capabilities).toEqual(['product_requirement']);
    expect(ceo?.capabilities).not.toContain('implementation');
  });
});

describe('capability candidate matching (M1.6)', () => {
  it('ranks the staffed holder of the declaring seat', () => {
    const candidates = matchCapabilityCandidates(seed, {
      requiredCapabilities: ['implementation'],
    });
    expect(candidates.map((candidate) => String(candidate.profile.employeeId))).toEqual([
      'engineer-mike',
    ]);
    expect(candidates[0]).toMatchObject({
      score: CAPABILITY_MATCH_SCORE,
      matchedCapabilities: ['implementation'],
      departmentMatch: false,
      available: true,
    });
  });

  it('breaks a tie by seat seniority, most junior first', () => {
    // `product_requirement` is declared by both the CEO (authority 5) and the PM (4); the
    // more specific, more junior seat wins so the work lands closest to the problem.
    const candidates = matchCapabilityCandidates(seed, {
      requiredCapabilities: ['product_requirement'],
    });
    expect(candidates.map((candidate) => String(candidate.profile.employeeId))).toEqual([
      'pm-bona',
      'ceo-alex',
    ]);
    expect(candidates[0]?.score).toBe(candidates[1]?.score);
  });

  it('ranks coverage above department and seniority', () => {
    const org = capabilityOrg();
    const candidates = matchCapabilityCandidates(org, {
      requiredCapabilities: ['implementation', 'testing'],
    });
    // Alex covers both required capabilities (20 points) and beats the single-capability
    // specialists regardless of department or seat seniority.
    expect(candidates[0]?.profile.employeeId).toBe('alex');
    expect(candidates[0]?.matchedCapabilities).toEqual(['implementation', 'testing']);
    expect(candidates[0]?.score).toBe(2 * CAPABILITY_MATCH_SCORE);
    expect(candidates.map((candidate) => String(candidate.profile.employeeId))).toEqual([
      'alex',
      'dora',
      'ron',
    ]);
  });

  it('uses the requested department only as a tie-break bonus', () => {
    const org = capabilityOrg();
    const candidates = matchCapabilityCandidates(org, {
      requiredCapabilities: ['implementation'],
      departmentId: 'lab',
    });
    expect(candidates.map((candidate) => String(candidate.profile.employeeId))).toEqual([
      'dora',
      'alex',
    ]);
    expect(candidates[0]?.score).toBe(CAPABILITY_MATCH_SCORE + DEPARTMENT_MATCH_SCORE);
    expect(candidates[1]?.score).toBe(CAPABILITY_MATCH_SCORE);
    expect(candidates[1]?.departmentMatch).toBe(false);
  });

  it('drops the candidates the caller marks unavailable', () => {
    const org = capabilityOrg();
    const best = bestCapabilityMatch(
      org,
      { requiredCapabilities: ['implementation'], departmentId: 'lab' },
      { unavailable: new Set<EmployeeId>(['dora' as EmployeeId]) },
    );
    expect(best?.profile.employeeId).toBe('alex');

    const candidates = matchCapabilityCandidates(
      org,
      { requiredCapabilities: ['implementation'], departmentId: 'lab' },
      { unavailable: new Set<EmployeeId>(['dora' as EmployeeId]) },
    );
    expect(candidates.map((candidate) => String(candidate.profile.employeeId))).toEqual(['alex']);
  });

  it('never selects an employee whose employment cannot take work', () => {
    const org = capabilityOrg('on_leave');
    const candidates = matchCapabilityCandidates(org, {
      requiredCapabilities: ['implementation'],
    });
    expect(candidates.map((candidate) => String(candidate.profile.employeeId))).toEqual(['alex']);
    expect(
      candidates.some((candidate) => String(candidate.profile.employeeId) === 'dora'),
    ).toBe(false);
  });

  it('escalates a vacant declaring seat to the nearest staffed manager', () => {
    const org = vacantSeatOrg();
    const best = bestCapabilityMatch(org, { requiredCapabilities: ['implementation'] });
    // Both declaring seats are empty, so the work lands on their staffed manager: the CEO.
    expect(best?.profile.employeeId).toBe('alex');
    expect(best?.matchedCapabilities).toEqual(['implementation']);
  });

  it('matches nobody for an empty requirement or an undeclared capability', () => {
    expect(matchCapabilityCandidates(seed, { requiredCapabilities: [] })).toEqual([]);
    expect(
      matchCapabilityCandidates(seed, { requiredCapabilities: ['teleportation'] }),
    ).toEqual([]);
    expect(bestCapabilityMatch(seed, { requiredCapabilities: ['teleportation'] })).toBeNull();
  });
});

describe('capability matching · the person-level expertise route (M1.6)', () => {
  it('matches an agent by personal expertise when no seat declares the requirement', () => {
    // `typescript` exists only as Mike's specialization — no seat in the company declares it, so
    // the seat route finds nobody and the expertise route is the only thing that can answer.
    expect(seed.positions.some((position) => (position.capabilities ?? []).includes('typescript'))).toBe(
      false,
    );
    const candidates = matchCapabilityCandidates(seed, {
      requiredCapabilities: ['typescript'],
    });
    expect(candidates.map((candidate) => String(candidate.profile.employeeId))).toEqual([
      'engineer-mike',
    ]);
    expect(candidates[0]).toMatchObject({
      matchedCapabilities: ['typescript'],
      expertiseMatched: ['typescript'],
      score: CAPABILITY_MATCH_SCORE,
    });
  });

  it('marks a requirement the seat already declares as non-expertise evidence', () => {
    const best = bestCapabilityMatch(seed, { requiredCapabilities: ['frontend'] });
    expect(best?.profile.employeeId).toBe('engineer-mike');
    // The engineer seat declares `frontend`, so the route is the organizational default and the
    // expertise flag stays empty — the audit trail must not claim a person-level detour.
    expect(best?.matchedCapabilities).toEqual(['frontend']);
    expect(best?.expertiseMatched).toEqual([]);
  });

  it('widen the candidate field: expertise covers a seat that declares nothing', () => {
    const org = load({
      'company.yaml': 'id: acme\nname: Acme\n',
      'positions/ceo.yaml':
        'id: ceo\ntitle: Chief Executive Officer\nauthority_level: 5\ncapabilities:\n  - implementation\n',
      'positions/ops.yaml': 'id: ops\ntitle: Operations\nauthority_level: 3\n',
      'employees/alex.yaml': 'id: alex\nname: Alex\nposition: ceo\n',
      'employees/dora.yaml':
        'id: dora\nname: Dora\nposition: ops\nexpertise:\n  - implementation\n',
    });
    const candidates = matchCapabilityCandidates(org, {
      requiredCapabilities: ['implementation'],
    });
    expect(candidates.map((candidate) => String(candidate.profile.employeeId)).sort()).toEqual([
      'alex',
      'dora',
    ]);
    const byId = new Map(candidates.map((candidate) => [String(candidate.profile.employeeId), candidate]));
    expect(byId.get('alex')?.expertiseMatched).toEqual([]);
    expect(byId.get('dora')?.expertiseMatched).toEqual(['implementation']);
    // Coverage — not the route — drives the score: both cover exactly one capability.
    expect(byId.get('alex')?.score).toBe(byId.get('dora')?.score);
  });

  it('reads matched capabilities in the requirement\'s own order across both routes', () => {
    const best = bestCapabilityMatch(seed, {
      requiredCapabilities: ['typescript', 'frontend'],
    });
    expect(best?.profile.employeeId).toBe('engineer-mike');
    // `typescript` came from the person, `frontend` from the seat; the recorded list follows the
    // requirement order regardless, so the explanation is stable.
    expect(best?.matchedCapabilities).toEqual(['typescript', 'frontend']);
    expect(best?.expertiseMatched).toEqual(['typescript']);
    expect(best?.score).toBe(2 * CAPABILITY_MATCH_SCORE);
  });

  it('still invents no candidate for a tag neither a seat nor a person declares', () => {
    expect(
      matchCapabilityCandidates(seed, { requiredCapabilities: ['teleportation'] }),
    ).toEqual([]);
  });
});
