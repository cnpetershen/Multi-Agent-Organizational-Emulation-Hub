import type {
  ActorContext,
  AuthorityLevel,
  DecisionDomain,
  EmployeeId,
} from '@maoeh/shared-types';
import { DECISION_DOMAINS } from '@maoeh/shared-types';
import type { Organization } from '@maoeh/organization-model';
import { createOrgGraph } from '@maoeh/organization-model';

export interface AuthorityRequirement {
  readonly domain: DecisionDomain;
  readonly level: AuthorityLevel;
}

export interface AuthorityService {
  levelFor(employeeId: EmployeeId, domain: DecisionDomain): AuthorityLevel;
  domainsFor(employeeId: EmployeeId): Readonly<Record<DecisionDomain, AuthorityLevel>>;
  meets(employeeId: EmployeeId, requirement: AuthorityRequirement): boolean;
}

function zeroDomains(): Record<DecisionDomain, AuthorityLevel> {
  const zero = 0 as AuthorityLevel;
  return {
    engineering: zero,
    product: zero,
    ops: zero,
    marketing: zero,
    finance: zero,
    org: zero,
  };
}

function domainsOf(
  decisionDomains: Partial<Record<DecisionDomain, AuthorityLevel>> | undefined,
): Record<DecisionDomain, AuthorityLevel> {
  const domains = zeroDomains();
  if (decisionDomains === undefined) return domains;
  for (const domain of DECISION_DOMAINS) {
    const level = decisionDomains[domain];
    if (level !== undefined) domains[domain] = level;
  }
  return domains;
}

export function levelForContext(
  actor: ActorContext,
  domain: DecisionDomain,
): AuthorityLevel {
  return actor.authorityByDomain[domain];
}

export function meetsContextAuthority(
  actor: ActorContext,
  requirement: AuthorityRequirement,
): boolean {
  return levelForContext(actor, requirement.domain) >= requirement.level;
}

export function createAuthorityService(organization: Organization): AuthorityService {
  const graph = createOrgGraph(organization);

  const domainsFor = (
    employeeId: EmployeeId,
  ): Readonly<Record<DecisionDomain, AuthorityLevel>> => {
    const employee = graph.getEmployee(employeeId);
    if (employee === null) return zeroDomains();
    const position = graph.getPosition(employee.positionId);
    if (position === null) return zeroDomains();
    return domainsOf(position.decisionDomains);
  };

  const levelFor = (employeeId: EmployeeId, domain: DecisionDomain): AuthorityLevel =>
    domainsFor(employeeId)[domain];

  const meets = (employeeId: EmployeeId, requirement: AuthorityRequirement): boolean =>
    levelFor(employeeId, requirement.domain) >= requirement.level;

  return { levelFor, domainsFor, meets };
}
