import { describe, expect, it } from 'vitest';
import type { Action } from '@maoeh/shared-types';
import { DEFAULT_AGENT_POLICY, PLAN_ACTION_BINDINGS } from '@maoeh/kernel';
import { createIdentity } from '@maoeh/identity-system';
import { createAuthzService, resourceRef } from '@maoeh/permission-system';
import { loadSeedOrganizationWithOperators } from '../helpers/control-fixtures';

/**
 * Regression for the M1.0 runtime defect found by dogfooding:
 *
 * `PLAN_ACTION_BINDINGS` implements `SendMessage`, but `DEFAULT_AGENT_POLICY` never granted the
 * `SendMessage` action, so the Communication layer was dead in the running kernel: every message
 * an agent tried to send was answered with `permission_denied` before the channel was even
 * consulted.
 *
 * The invariant this test pins: every action the kernel plan executor can actually execute must
 * be permitted by the kernel's own default policy.
 */
const RESOURCE_FOR_BINDING: Readonly<Record<string, string>> = Object.freeze({
  'workflow.start': 'workflow:product-analysis',
  'workflow.approve': 'workflow:instance-1',
  'tasks.dispatch': 'position:engineer',
  'tasks.accept': 'task:task-1',
  'tasks.start': 'task:task-1',
  'tasks.submit': 'task:task-1',
  'tasks.complete': 'task:task-1',
  'tasks.reject': 'task:task-1',
  'tasks.block': 'task:task-1',
  'communication.sendMessage': 'channel:chan-1',
  'collaboration.request': 'channel:collaboration',
  'runtime.presenceChanged': 'runtime:runtime',
  'agents.create': 'position:engineer',
});

describe('M1.0 regression: the kernel default policy permits every executable agent action', () => {
  const organization = loadSeedOrganizationWithOperators();
  const identity = createIdentity(organization);
  const authz = createAuthzService({ organization, policy: DEFAULT_AGENT_POLICY });
  const ceo = identity.actorContext('ceo-alex', 'corr-policy-regression' as never);

  it('covers every implemented plan action binding', () => {
    const executable = [...new Set(Object.values(PLAN_ACTION_BINDINGS))].filter(
      (binding) => binding !== 'noop',
    );
    expect(executable.length).toBeGreaterThan(0);
    for (const binding of executable) {
      expect(RESOURCE_FOR_BINDING[binding], `no resource declared for binding ${binding}`).toBeDefined();
    }
  });

  it('allows each binding through the real AuthzService', () => {
    const denials: string[] = [];
    for (const [action, binding] of Object.entries(PLAN_ACTION_BINDINGS)) {
      if (binding === 'noop') continue;
      const resource = RESOURCE_FOR_BINDING[binding];
      if (resource === undefined) continue;
      const mapped = binding === 'workflow.start' ? 'CreateProposal' : ACTION_FOR_BINDING[action];
      const decision = authz.can(ceo, mapped as Action, resourceRef(resource));
      if (!decision.allow) denials.push(`${action} -> ${binding} (${resource})`);
    }
    expect(denials).toEqual([]);
  });
});

/** The permission action each plan action is authorized under by its domain service. */
const ACTION_FOR_BINDING: Readonly<Record<string, string>> = Object.freeze({
  CreateProposal: 'CreateProposal',
  DispatchWork: 'DispatchWork',
  AcceptTask: 'AcceptTask',
  StartTask: 'StartTask',
  ProgressReport: 'ProgressReport',
  SubmitReport: 'SubmitReport',
  CompleteTask: 'CompleteTask',
  RejectTask: 'RejectTask',
  BlockTask: 'BlockTask',
  CastVote: 'CastVote',
  ApproveStep: 'ApproveStep',
  RejectStep: 'RejectStep',
  SendMessage: 'SendMessage',
  RequestCollaboration: 'SendMessage',
  UpdatePresence: 'UpdatePresence',
  Reflect: 'UpdatePresence',
  RecommendHire: 'ControlAgent',
});
