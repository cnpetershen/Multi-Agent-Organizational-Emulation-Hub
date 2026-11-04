import { describe, expect, it } from 'vitest';
import type { CorrelationId, DecisionDomain, EmployeeId, PositionId } from '@maoeh/shared-types';
import { createIdentity } from '@maoeh/identity-system';
import { organizationSnapshotView } from '@maoeh/kernel';
import { createOrgGraph } from '@maoeh/organization-model';
import type { PermissionPolicy } from '@maoeh/permission-system';
import { createAuthzService, resourceRef } from '@maoeh/permission-system';
import { loadSeedOrganization, loadSeedWorkflows } from '../../helpers/simulation-fixtures';

/**
 * 基础组织结构：**CEO → 部门 → 员工**。
 *
 * The reporting lines are asserted against the *seed* (`agents/future-ai-lab/`), not against a
 * synthetic fixture. That distinction is the whole point of this file: the unit fixtures already
 * declared `reports_to` while the seed declared none, so every running agent saw
 * `Manager: (none)` and the organization was flat in production even though the model supported
 * hierarchy. A fixture can prove the model works; only the seed can prove the company is wired.
 *
 * Three properties are pinned here:
 *   1. shape — every department has a head, heads report to the CEO, everyone else reports to
 *      their own department's head;
 *   2. authority — a head outranks the members of its own department (and the CEO outranks the
 *      heads), so the reporting line is also a decision line;
 *   3. consequences — an over-reach escalates to the direct manager, and every seeded approval
 *      gate is reachable by the role it names, so no gate can deadlock by construction.
 */

const seed = loadSeedOrganization();
const graph = createOrgGraph(seed);
const identity = createIdentity(seed);
const workflows = loadSeedWorkflows();

/** The seed's departments map one-to-one onto the decision domains they own. */
const DEPARTMENT_DOMAIN: Readonly<Record<string, DecisionDomain>> = {
  engineering: 'engineering',
  product: 'product',
  marketing: 'marketing',
  // Research 与 Business 是种子新增的两个部门：前者守工程决策域（AI/Agent 研发），
  // 后者守市场决策域（增长与商业分析），因此负责人同样要在这两个域上达到 L3。
  research: 'engineering',
  business: 'marketing',
};

const positionOf = (positionId: string) =>
  graph.getPosition(positionId as PositionId);

const domainLevel = (positionId: string, domain: DecisionDomain): number =>
  positionOf(positionId)?.decisionDomains?.[domain] ?? 0;

function managerOf(employeeId: string): string | null {
  return graph.getManagerOf(employeeId as EmployeeId)?.id ?? null;
}

describe('基础组织结构：CEO → 部门 → 员工（种子）', () => {
  it('每个部门都有负责人，且负责人是本部门的岗位', () => {
    for (const department of seed.departments) {
      const headPositionId = department.headPositionId;
      expect(headPositionId, `${department.id} 没有 head_position`).not.toBeNull();
      if (headPositionId === null) continue;
      const head = positionOf(headPositionId);
      expect(head, `${department.id} 的负责人岗位不存在`).not.toBeNull();
      expect(head?.departmentId, `${department.id} 的负责人不在本部门`).toBe(department.id);
      expect(DEPARTMENT_DOMAIN[department.id]).toBeDefined();
    }
  });

  it('部门负责人直接向 CEO 汇报，部门内其他人向本部门负责人汇报', () => {
    expect(seed.positions.map((p) => [p.id, p.reportsToPositionId])).toEqual([
      ['agent-engineer', 'ai-researcher'],
      ['ai-engineer', 'cto'],
      ['ai-researcher', 'ceo'],
      ['backend-engineer', 'cto'],
      ['business-analyst', 'growth-manager'],
      ['ceo', null],
      ['cto', 'ceo'],
      ['devops-engineer', 'cto'],
      ['engineer', 'cto'],
      ['frontend-engineer', 'cto'],
      ['growth-manager', 'ceo'],
      ['marketing-manager', 'ceo'],
      ['product-manager', 'ceo'],
      ['qa', 'cto'],
      ['ux-designer', 'product-manager'],
    ]);
  });

  it('员工层能解析出两层汇报链：员工 → 部门负责人 → CEO', () => {
    expect(managerOf('engineer-mike')).toBe('cto-john');
    expect(managerOf('qa-peter')).toBe('cto-john');
    expect(managerOf('pm-bona')).toBe('ceo-alex');
    expect(managerOf('marketing-jack')).toBe('ceo-alex');
    expect(managerOf('cto-john')).toBe('ceo-alex');
    // 公司级岗位是结构树的根。
    expect(managerOf('ceo-alex')).toBeNull();
    expect(graph.getReports('ceo-alex' as EmployeeId).map((e) => e.id)).toEqual([
      'cto-john',
      'marketing-jack',
      'pm-bona',
    ]);
    expect(graph.getReports('cto-john' as EmployeeId).map((e) => e.id)).toEqual([
      'engineer-mike',
      'qa-peter',
    ]);
  });

  it('负责人是本部门的最高决策等级（L3 部门决策），CEO 在各部门域内不低于负责人', () => {
    for (const department of seed.departments) {
      const headPositionId = department.headPositionId;
      const domain = DEPARTMENT_DOMAIN[department.id];
      if (headPositionId === null || domain === undefined) continue;

      const headLevel = domainLevel(headPositionId, domain);
      expect(headLevel, `${headPositionId} 没有 ${domain} 域决策权`).toBeGreaterThanOrEqual(3);
      expect(domainLevel('ceo', domain)).toBeGreaterThanOrEqual(headLevel);

      for (const position of seed.positions) {
        if (position.departmentId !== department.id || position.id === headPositionId) continue;
        expect(
          headLevel,
          `${headPositionId} 管不住本部门的 ${position.id}`,
        ).toBeGreaterThanOrEqual(domainLevel(position.id, domain));
      }
    }
  });

  it('越权升级落在直属上级身上（工程师 → CTO，CTO → CEO，CEO 自己就能拍板）', () => {
    // A company-level threshold only the CEO reaches: exactly how the runtime distinguishes
    // "you may not" from "you may not, ask your manager".
    const policy: PermissionPolicy = {
      grants: [
        {
          subject: { kind: 'any' },
          action: 'ApproveStep',
          resource: 'workflow:*',
          minAuthority: { domain: 'org', level: 4 },
        },
      ],
      denies: [],
    };
    const authz = createAuthzService({ organization: seed, policy });
    const resource = resourceRef('workflow:wf-1/step:decision-gate');
    const actor = (employeeId: string) =>
      identity.actorContext(employeeId as EmployeeId, 'corr-hierarchy' as CorrelationId);

    const engineer = authz.can(actor('engineer-mike'), 'ApproveStep', resource);
    expect(engineer.allow).toBe(false);
    if (!engineer.allow) {
      expect(engineer.reason).toBe('NEEDS_APPROVAL');
      expect(engineer.requiredAuthority).toBe(4);
      expect(engineer.escalateTo).toBe('cto-john');
    }

    const cto = authz.can(actor('cto-john'), 'ApproveStep', resource);
    expect(cto.allow).toBe(false);
    if (!cto.allow) {
      expect(cto.reason).toBe('NEEDS_APPROVAL');
      expect(cto.escalateTo).toBe('ceo-alex');
    }

    const ceo = authz.can(actor('ceo-alex'), 'ApproveStep', resource);
    expect(ceo.allow).toBe(true);
  });

  it('Agent 每轮拿到的组织切片带着汇报线（提示词 Manager/Reports 的来源）', () => {
    // `organizationSnapshotView` 是运行时喂给认知提示词的组织切片：
    // 它一旦为空，Agent 就会把所有人当平级同事，这正是本次要修掉的症状。
    const engineerView = organizationSnapshotView(seed, 'engineer-mike' as EmployeeId);
    expect(engineerView.manager).toEqual({ id: 'cto-john', name: 'John' });
    expect(engineerView.department).toEqual({ id: 'engineering', name: 'Engineering' });

    const ctoView = organizationSnapshotView(seed, 'cto-john' as EmployeeId);
    expect(ctoView.manager).toEqual({ id: 'ceo-alex', name: 'Alex' });
    expect(ctoView.reports).toEqual([
      { id: 'engineer-mike', name: 'Mike' },
      { id: 'qa-peter', name: 'Peter' },
    ]);

    const ceoView = organizationSnapshotView(seed, 'ceo-alex' as EmployeeId);
    expect(ceoView.manager).toBeNull();
    expect(ceoView.reports).toEqual([
      { id: 'cto-john', name: 'John' },
      { id: 'marketing-jack', name: 'Jack' },
      { id: 'pm-bona', name: 'Bona' },
    ]);
  });

  it('Agent 拿到的组织切片带着全组织的能力总表（能力叠加的来源）', () => {
    // `Position capabilities` answers "what can *I* do"; the capability map answers "what can
    // *we* do". Without the latter a planner sees only its own seat's tags — which is how a
    // task book came to decompose into a single narrow step.
    const view = organizationSnapshotView(seed, 'ceo-alex' as EmployeeId);
    const offers = view.capabilityMap ?? [];
    expect(offers.length).toBeGreaterThan(0);

    // Listings are sorted by capability so the rendered prompt is deterministic.
    expect([...offers].map((offer) => offer.capability)).toEqual(
      [...offers].map((offer) => offer.capability).sort(),
    );
    // Every listed seat really declares the capability it is listed under (never title matching).
    for (const offer of offers) {
      expect(offer.seats.length).toBeGreaterThan(0);
      for (const seat of offer.seats) {
        const position = seed.positions.find((entry) => entry.id === seat.id);
        expect(position?.capabilities ?? []).toContain(offer.capability);
        expect(seat.title).toBe(position?.title);
      }
    }

    // `implementation` is declared by several seats, so the planner can choose a staffed one.
    const implementation = offers.find((offer) => offer.capability === 'implementation');
    expect(implementation).toBeDefined();
    expect(implementation?.seats.length ?? 0).toBeGreaterThan(1);
    expect(implementation?.seats.some((seat) => seat.title === 'Software Engineer')).toBe(true);
  });

  it('每个种子审批门都能被它指定的角色按等级满足（不会构造性死锁）', () => {
    const gates = workflows.flatMap((definition) =>
      definition.stages.flatMap((stage) =>
        stage.steps
          .filter((step) => step.kind === 'approval')
          .map((step) => ({ workflowId: definition.workflowId, step })),
      ),
    );
    expect(gates.length).toBeGreaterThan(0);

    for (const { workflowId, step } of gates) {
      const requirement = step.requiredAuthority;
      if (requirement === null) continue;
      const candidates = seed.positions.filter((position) =>
        step.requiredRoles.length === 0
          ? true
          : step.requiredRoles.some((role) =>
              [position.id, position.key, position.roleCode].includes(role),
            ),
      );
      const reachable = candidates.some(
        (position) =>
          (position.decisionDomains?.[requirement.domain] ?? 0) >= requirement.level,
      );
      expect(
        reachable,
        `${workflowId}/${step.stepId} 要求 ${requirement.domain} L${String(requirement.level)}，但没有角色能达到`,
      ).toBe(true);
    }
  });
});
