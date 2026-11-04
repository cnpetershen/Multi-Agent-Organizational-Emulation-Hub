import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CorrelationId, SimTime } from '@maoeh/shared-types';
import type { AgentDefinition, AgentDefinitionSourceReader } from '@maoeh/agent-definition';
import { loadAgentDefinitions } from '@maoeh/agent-definition';
import type { CognitionProfile, CognitionSourceReader } from '@maoeh/agent-cognition';
import { loadCognitionProfiles } from '@maoeh/agent-cognition';
import type { AgentInstance } from '@maoeh/agent-runtime';
import { instantiateAgent } from '@maoeh/agent-runtime';
import type { Identity } from '@maoeh/identity-system';
import { createIdentity } from '@maoeh/identity-system';
import type { Organization } from '@maoeh/organization-model';
import { loadOrganization } from '@maoeh/organization-model';
import { createInitialAgentState } from '@maoeh/runtime-state';
import { createNodeFsOrganizationReader } from '../helpers/organization-readers';

const seedRoot = fileURLToPath(new URL('../../agents/future-ai-lab/', import.meta.url));
const sim = (minutes: number): SimTime => minutes as SimTime;

function createAgentSourceReader(): AgentDefinitionSourceReader & CognitionSourceReader {
  return {
    async list(relativeDirectory) {
      const directory = join(seedRoot, relativeDirectory);
      if (!existsSync(directory)) return [];
      return readdirSync(directory)
        .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .map((entry) => `${relativeDirectory}/${entry}`)
        .sort();
    },
    async read(relativePath) {
      const filePath = join(seedRoot, relativePath);
      if (!existsSync(filePath)) return null;
      return readFileSync(filePath, 'utf8');
    },
  };
}

interface Bootstrap {
  readonly organization: Organization;
  readonly identity: Identity;
  readonly profiles: readonly CognitionProfile[];
  readonly definitions: readonly AgentDefinition[];
  readonly instances: readonly AgentInstance[];
}

async function runChain(): Promise<Bootstrap> {
  const organizationResult = loadOrganization(createNodeFsOrganizationReader(seedRoot));
  if (!organizationResult.ok) {
    throw new Error(
      `seed organization failed: ${organizationResult.error.issues
        .map((issue) => `${issue.source}:${issue.reason}`)
        .join(', ')}`,
    );
  }
  const organization = organizationResult.value;
  const reader = createAgentSourceReader();
  const profilesResult = await loadCognitionProfiles({ reader });
  if (!profilesResult.ok) {
    throw new Error(
      `cognition profiles failed: ${profilesResult.error.issues
        .map((issue) => `${issue.source}:${issue.field}`)
        .join(', ')}`,
    );
  }
  const definitionsResult = await loadAgentDefinitions({
    reader,
    organization,
    cognitionProfileIds: profilesResult.value.map((profile) => profile.id),
  });
  if (!definitionsResult.ok) {
    throw new Error(
      `agent definitions failed: ${definitionsResult.error.issues
        .map((issue) => `${issue.source}:${issue.field}`)
        .join(', ')}`,
    );
  }
  const identity = createIdentity(organization);
  const instances: AgentInstance[] = [];
  for (const definition of definitionsResult.value) {
    const context = identity.actorContext(
      definition.employeeId,
      `corr-m04-${definition.employeeId}` as CorrelationId,
    );
    const instanceResult = instantiateAgent(definition, context, sim(0));
    if (!instanceResult.ok) {
      throw new Error(
        `instantiate failed for ${definition.id}: ${instanceResult.error.issues
          .map((issue) => `${issue.field}:${issue.reason}`)
          .join(', ')}`,
      );
    }
    instances.push(instanceResult.value);
  }
  return {
    organization,
    identity,
    profiles: profilesResult.value,
    definitions: definitionsResult.value,
    instances,
  };
}

let cachedBootstrap: Bootstrap | undefined;

async function bootstrap(): Promise<Bootstrap> {
  if (cachedBootstrap === undefined) cachedBootstrap = await runChain();
  return cachedBootstrap;
}

async function definitionFor(employeeId: string): Promise<AgentDefinition> {
  const { definitions } = await bootstrap();
  const definition = definitions.find((candidate) => candidate.employeeId === employeeId);
  if (definition === undefined) throw new Error(`no definition for employee ${employeeId}`);
  return definition;
}

async function instanceFor(employeeId: string): Promise<AgentInstance> {
  const { instances } = await bootstrap();
  const instance = instances.find((candidate) => candidate.employeeId === employeeId);
  if (instance === undefined) throw new Error(`no instance for employee ${employeeId}`);
  return instance;
}

describe('M0.4 集成：agents/future-ai-lab → Organization → AgentDefinition → AgentInstance → AgentState', () => {
  it('种子组织加载：6 名员工（CEO / CTO / 工程师 / 市场 / 产品 / QA）', async () => {
    const { organization } = await bootstrap();
    expect(organization.employees.map((employee) => employee.id).sort()).toEqual([
      'ceo-alex',
      'cto-john',
      'engineer-mike',
      'marketing-jack',
      'pm-bona',
      'qa-peter',
    ]);
  });

  it('认知配置加载：6 个 profile（按路径排序）', async () => {
    const { profiles } = await bootstrap();
    expect(profiles.map((profile) => profile.id)).toEqual([
      'exec-strategic',
      'exec-technical',
      'market-growth',
      'product-strategy',
      'quality-assurance',
      'tech-task',
    ]);
    for (const profile of profiles) {
      expect(profile.reasoningStyle).not.toBe('');
      expect(profile.planningStyle).not.toBe('');
      expect(profile.decisionFramework).not.toBe('');
      expect(profile.reflectionPolicy).not.toBe('');
    }
  });

  it('AgentDefinition 加载：每员工一份，绑定组织 employee/position/name，认知引用闭合', async () => {
    const { definitions, organization, profiles } = await bootstrap();
    expect(definitions.map((definition) => definition.id)).toEqual([
      'agent-ceo-alex',
      'agent-cto-john',
      'agent-engineer-mike',
      'agent-marketing-jack',
      'agent-pm-bona',
      'agent-qa-peter',
    ]);
    const profileIds = profiles.map((profile) => profile.id);
    for (const definition of definitions) {
      const employee = organization.employees.find(
        (candidate) => candidate.id === definition.employeeId,
      );
      expect(employee).toBeDefined();
      if (employee === undefined) continue;
      expect(definition.positionId).toBe(employee.positionId);
      expect(definition.identity.name).toBe(employee.name);
      expect(profileIds).toContain(definition.cognitionProfileId);
      expect(definition.responsibilities.length).toBeGreaterThan(0);
      expect(definition.toolPolicy.allowed.length).toBeGreaterThan(0);
      expect(definition.memoryPolicy.retain.length).toBeGreaterThan(0);
    }
  });

  it('CEO（ceo-alex）：position ceo、无 department、实例初始状态 idle/defined/version 0', async () => {
    const definition = await definitionFor('ceo-alex');
    expect(definition.positionId).toBe('ceo');
    expect(definition.departmentId).toBeUndefined();
    expect(definition.cognitionProfileId).toBe('exec-strategic');
    const instance = await instanceFor('ceo-alex');
    expect(instance.id).toBe('agent:agent-ceo-alex');
    expect(instance.definitionId).toBe('agent-ceo-alex');
    expect(instance.employeeId).toBe('ceo-alex');
    expect(instance.createdAtSim).toBe(0);
    expect(instance.state.presence).toBe('idle');
    expect(instance.state.employment).toBe('defined');
    expect(instance.state.version).toBe(0);
    expect(instance.state.branchId).toBe('live');
    expect(instance.state).toEqual(createInitialAgentState(definition.employeeId));
  });

  it('CTO（cto-john）与工程师（engineer-mike）：departmentId engineering，实例与员工链一致', async () => {
    const ctoDefinition = await definitionFor('cto-john');
    const engineerDefinition = await definitionFor('engineer-mike');
    expect(ctoDefinition.positionId).toBe('cto');
    expect(ctoDefinition.departmentId).toBe('engineering');
    expect(ctoDefinition.cognitionProfileId).toBe('exec-technical');
    expect(engineerDefinition.positionId).toBe('engineer');
    expect(engineerDefinition.departmentId).toBe('engineering');
    expect(engineerDefinition.cognitionProfileId).toBe('tech-task');
    for (const definition of [ctoDefinition, engineerDefinition]) {
      const instance = await instanceFor(definition.employeeId);
      expect(instance.employeeId).toBe(definition.employeeId);
      expect(instance.definitionId).toBe(definition.id);
      expect(instance.id).toBe(`agent:${definition.id}`);
      expect(instance.state.presence).toBe('idle');
      expect(instance.state.employment).toBe('defined');
      expect(instance.state.version).toBe(0);
      expect(instance.state).toEqual(createInitialAgentState(definition.employeeId));
    }
  });

  it('实例 id 确定性：整链重新执行产出相同实例 id，六个实例互不相同', async () => {
    const first = await bootstrap();
    const second = await runChain();
    expect(second.instances.map((instance) => instance.id)).toEqual(
      first.instances.map((instance) => instance.id),
    );
    expect(new Set(first.instances.map((instance) => instance.id)).size).toBe(6);
  });

  it('绑定验证：identity context 与定义一致（employee/position/department 全部匹配）', async () => {
    const { definitions, identity } = await bootstrap();
    for (const definition of definitions) {
      const context = identity.actorContext(
        definition.employeeId,
        `corr-verify-${definition.employeeId}` as CorrelationId,
      );
      expect(context.employeeId).toBe(definition.employeeId);
      expect(context.positionId).toBe(definition.positionId);
      expect(context.departmentId).toBe(definition.departmentId ?? null);
      const result = instantiateAgent(definition, context, sim(5));
      expect(result.ok).toBe(true);
    }
  });
});
