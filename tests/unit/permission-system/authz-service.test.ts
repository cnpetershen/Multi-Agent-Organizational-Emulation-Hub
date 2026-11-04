import { describe, expect, it } from 'vitest';
import type { Action, ActorContext, CorrelationId, EmployeeId, PositionId } from '@maoeh/shared-types';
import type { PermissionPolicy } from '@maoeh/permission-system';
import {
  channelResource,
  createAuthzService,
  denyRule,
  employeeGrant,
  messageResource,
  positionGrant,
} from '@maoeh/permission-system';
import type { Identity } from '@maoeh/identity-system';
import { createIdentity } from '@maoeh/identity-system';
import type { Organization } from '@maoeh/organization-model';
import { loadMemoryOrganization } from '../../helpers/communication-fixtures';

const hierarchyFiles: Record<string, string> = {
  'company.yaml': 'id: acme\nname: Acme\n',
  'departments/engineering.yaml': 'id: engineering\nname: Engineering\n',
  'positions/ceo.yaml': 'id: ceo\ntitle: CEO\ndecision_domains:\n  org: L3\n',
  'positions/cto.yaml': 'id: cto\ntitle: CTO\ndepartment: engineering\nreports_to: ceo\n',
  'positions/engineer.yaml':
    'id: engineer\ntitle: Engineer\ndepartment: engineering\nreports_to: cto\n',
  'employees/ceo-alex.yaml': 'id: ceo-alex\nname: Alex\nposition: ceo\n',
  'employees/cto-john.yaml': 'id: cto-john\nname: John\nposition: cto\n',
  'employees/engineer-mike.yaml': 'id: engineer-mike\nname: Mike\nposition: engineer\n',
};

const emptyPolicy: PermissionPolicy = { grants: [], denies: [] };

const ctoSendGrant = positionGrant('cto' as PositionId, 'SendMessage', 'channel:*');

interface AuthzFixture {
  readonly organization: Organization;
  readonly identity: Identity;
  readonly ceo: ActorContext;
  readonly cto: ActorContext;
  readonly engineer: ActorContext;
}

function build(files: Record<string, string> = hierarchyFiles): AuthzFixture {
  const organization = loadMemoryOrganization(files);
  const identity = createIdentity(organization);
  return {
    organization,
    identity,
    ceo: identity.actorContext('ceo-alex' as EmployeeId, 'corr-ceo' as CorrelationId),
    cto: identity.actorContext('cto-john' as EmployeeId, 'corr-cto' as CorrelationId),
    engineer: identity.actorContext('engineer-mike' as EmployeeId, 'corr-eng' as CorrelationId),
  };
}

describe('permission-system：AuthzService.can', () => {
  it('无规则 → 默认拒绝（fail-closed, NO_PERMISSION）', () => {
    const fixture = build();
    const service = createAuthzService({ organization: fixture.organization, policy: emptyPolicy });
    const decision = service.can(fixture.ceo, 'SendMessage', channelResource('chan-1'));
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('NO_PERMISSION');
  });

  it('按岗位授权 → allow；按员工授权 → allow；他人无权', () => {
    const fixture = build();
    const byPosition = createAuthzService({
      organization: fixture.organization,
      policy: { grants: [ctoSendGrant], denies: [] },
    });
    expect(byPosition.can(fixture.cto, 'SendMessage', channelResource('dm')).allow).toBe(true);
    expect(byPosition.can(fixture.engineer, 'SendMessage', channelResource('dm')).allow).toBe(false);

    const byEmployee = createAuthzService({
      organization: fixture.organization,
      policy: {
        grants: [employeeGrant('engineer-mike' as EmployeeId, 'SendMessage', 'channel:dm')],
        denies: [],
      },
    });
    expect(byEmployee.can(fixture.engineer, 'SendMessage', channelResource('dm')).allow).toBe(true);
    expect(byEmployee.can(fixture.cto, 'SendMessage', channelResource('dm')).allow).toBe(false);
  });

  it('deny 规则优先于 grant（deny-overrides）', () => {
    const fixture = build();
    const service = createAuthzService({
      organization: fixture.organization,
      policy: {
        grants: [ctoSendGrant],
        denies: [
          denyRule(
            { kind: 'position', positionId: 'cto' as PositionId },
            'SendMessage',
            'channel:*',
          ),
        ],
      },
    });
    const decision = service.can(fixture.cto, 'SendMessage', channelResource('dm'));
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('NO_PERMISSION');
  });

  it('资源匹配：精确 / 全量 / 前缀通配', () => {
    const fixture = build();
    const allowOn = (resource: string) =>
      createAuthzService({
        organization: fixture.organization,
        policy: {
          grants: [{ subject: { kind: 'any' }, action: 'SendMessage' as Action, resource }],
          denies: [],
        },
      });

    expect(allowOn('channel:dm-1').can(fixture.ceo, 'SendMessage', channelResource('dm-1')).allow).toBe(true);
    expect(allowOn('channel:dm-1').can(fixture.ceo, 'SendMessage', channelResource('dm-2')).allow).toBe(false);
    expect(allowOn('*').can(fixture.ceo, 'SendMessage', channelResource('dm-2')).allow).toBe(true);
    expect(allowOn('channel:*').can(fixture.ceo, 'SendMessage', channelResource('dm-2')).allow).toBe(true);
    expect(
      allowOn('channel:*').can(fixture.ceo, 'SendMessage', messageResource('dm-1', 'msg-1')).allow,
    ).toBe(true);
    expect(allowOn('document:*').can(fixture.ceo, 'SendMessage', channelResource('dm-1')).allow).toBe(false);
    expect(allowOn('chan*').can(fixture.ceo, 'SendMessage', channelResource('dm-1')).allow).toBe(true);
  });

  it('actor 未知或岗位不符 → OUT_OF_SCOPE', () => {
    const fixture = build();
    const service = createAuthzService({ organization: fixture.organization, policy: emptyPolicy });

    const unknown = service.can(
      { ...fixture.ceo, employeeId: 'ghost' as EmployeeId },
      'SendMessage',
      channelResource('dm'),
    );
    expect(unknown.allow).toBe(false);
    if (!unknown.allow) expect(unknown.reason).toBe('OUT_OF_SCOPE');

    const mismatched = service.can(
      { ...fixture.ceo, positionId: 'engineer' as PositionId },
      'SendMessage',
      channelResource('dm'),
    );
    expect(mismatched.allow).toBe(false);
    if (!mismatched.allow) expect(mismatched.reason).toBe('OUT_OF_SCOPE');

    const emptyActor = service.can(
      { ...fixture.ceo, employeeId: '' as EmployeeId },
      'SendMessage',
      channelResource('dm'),
    );
    expect(emptyActor.allow).toBe(false);
    if (!emptyActor.allow) expect(emptyActor.reason).toBe('OUT_OF_SCOPE');
  });

  it('停职员工 → 即使有 grant 也拒绝（停职即失效）', () => {
    const fixture = build({
      ...hierarchyFiles,
      'employees/engineer-mike.yaml':
        'id: engineer-mike\nname: Mike\nposition: engineer\nstatus: suspended\n',
    });
    const policy: PermissionPolicy = {
      grants: [positionGrant('engineer' as PositionId, 'SendMessage', 'channel:*')],
      denies: [],
    };
    const service = createAuthzService({ organization: fixture.organization, policy });
    const decision = service.can(fixture.engineer, 'SendMessage', channelResource('dm'));
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('NO_PERMISSION');
  });

  it('minAuthority：等级足够 → allow；不足 → NEEDS_APPROVAL（escalateTo 直属上级）', () => {
    const thresholdPolicy: PermissionPolicy = {
      grants: [
        {
          subject: { kind: 'any' },
          action: 'SendMessage',
          resource: 'channel:*',
          minAuthority: { domain: 'org', level: 2 },
        },
      ],
      denies: [],
    };
    const fixture = build();
    const service = createAuthzService({
      organization: fixture.organization,
      policy: thresholdPolicy,
    });

    const engineer = service.can(fixture.engineer, 'SendMessage', channelResource('dm'));
    expect(engineer.allow).toBe(false);
    if (!engineer.allow) {
      expect(engineer.reason).toBe('NEEDS_APPROVAL');
      expect(engineer.requiredAuthority).toBe(2);
      expect(engineer.escalateTo).toBe('cto-john');
    }

    const ceo = service.can(fixture.ceo, 'SendMessage', channelResource('dm'));
    expect(ceo.allow).toBe(true);

    const soloOrganization = loadMemoryOrganization({
      'company.yaml': 'id: acme\nname: Acme\n',
      'positions/ceo.yaml': 'id: ceo\ntitle: CEO\n',
      'employees/ceo-alex.yaml': 'id: ceo-alex\nname: Alex\nposition: ceo\n',
    });
    const soloIdentity = createIdentity(soloOrganization);
    const soloService = createAuthzService({
      organization: soloOrganization,
      policy: thresholdPolicy,
    });
    const soloDecision = soloService.can(
      soloIdentity.actorContext('ceo-alex' as EmployeeId, 'corr-ceo' as CorrelationId),
      'SendMessage',
      channelResource('dm'),
    );
    expect(soloDecision.allow).toBe(false);
    if (!soloDecision.allow) {
      expect(soloDecision.reason).toBe('NEEDS_APPROVAL');
      expect(soloDecision.escalateTo).toBeUndefined();
    }
  });

  it('ctx.requiredRoles：岗位不符 → OUT_OF_SCOPE；相符仍需 grant', () => {
    const fixture = build();
    const policy: PermissionPolicy = {
      grants: [positionGrant('ceo' as PositionId, 'SendMessage', 'channel:*')],
      denies: [],
    };
    const service = createAuthzService({ organization: fixture.organization, policy });

    const matched = service.can(fixture.ceo, 'SendMessage', channelResource('dm'), {
      requiredRoles: ['ceo'],
    });
    expect(matched.allow).toBe(true);

    const unmatched = service.can(fixture.engineer, 'SendMessage', channelResource('dm'), {
      requiredRoles: ['ceo'],
    });
    expect(unmatched.allow).toBe(false);
    if (!unmatched.allow) expect(unmatched.reason).toBe('OUT_OF_SCOPE');

    const grantedButNoRole = service.can(fixture.ceo, 'Speak', channelResource('dm'), {
      requiredRoles: ['cto'],
    });
    expect(grantedButNoRole.allow).toBe(false);
    if (!grantedButNoRole.allow) expect(grantedButNoRole.reason).toBe('OUT_OF_SCOPE');
  });
});

describe('permission-system：AuthzService.effective', () => {
  it('返回有效权限集合，停职或岗位无权限时为空', () => {
    const policy: PermissionPolicy = {
      grants: [
        positionGrant('cto' as PositionId, 'SendMessage', 'channel:*'),
        positionGrant('cto' as PositionId, 'channel.read', 'channel:*'),
        employeeGrant('cto-john' as EmployeeId, 'Reply', 'channel:dm-1'),
      ],
      denies: [
        denyRule(
          { kind: 'employee', employeeId: 'cto-john' as EmployeeId },
          'Announce',
          'channel:*',
        ),
      ],
    };
    const fixture = build();
    const service = createAuthzService({ organization: fixture.organization, policy });

    const ctoSet = service.effective('cto-john' as EmployeeId);
    expect(ctoSet.employeeId).toBe('cto-john');
    expect(ctoSet.granted.map((entry) => entry.action).sort()).toEqual([
      'Reply',
      'SendMessage',
      'channel.read',
    ]);
    expect(ctoSet.denied).toEqual([{ action: 'Announce', resource: 'channel:*' }]);

    const engineerSet = service.effective('engineer-mike' as EmployeeId);
    expect(engineerSet.granted).toHaveLength(0);
    expect(engineerSet.denied).toHaveLength(0);

    const unknownSet = service.effective('ghost' as EmployeeId);
    expect(unknownSet.granted).toHaveLength(0);
    expect(unknownSet.denied).toHaveLength(0);
  });
});
