const ws = (name) => `(^packages/${name}/|^@maoeh/${name}(/|$))`;

const domainPackages = [
  'organization-model',
  'identity-system',
  'permission-system',
  'authority-engine',
  'policy-engine',
  'shared-types',
];

const orchestrationPackages = [
  'workflow-engine',
  'task-system',
  'decision-engine',
  'meeting-engine',
  'escalation-engine',
  'agent-communication',
];

export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Cycle Rule: dependency cycles are forbidden (no exceptions)',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-apps',
      severity: 'error',
      comment: 'F1: packages/* must not import apps/*',
      from: { path: '^packages/' },
      to: { path: '(^apps/|^@maoeh/(kernel|api|projector|web)(/|$))' },
    },
    {
      name: 'web-no-backend',
      severity: 'error',
      comment: 'F2: apps/web must not import any @maoeh/* backend package',
      from: { path: '^apps/web/' },
      to: {
        path: '(^packages/|^apps/|^@maoeh/)',
        pathNot: '^apps/web/',
      },
    },
    {
      name: 'domain-pure',
      severity: 'error',
      comment: 'F3/F4/F10: domain packages may only import same-group packages',
      from: { path: `^packages/(${domainPackages.join('|')})/` },
      to: {
        path: '(^packages/|^@maoeh/)',
        pathNot: domainPackages.map(ws),
      },
    },
    {
      name: 'agent-no-io',
      severity: 'error',
      comment: 'F5: agent-definition/agent-cognition must not import persistence/event-*',
      from: { path: '^packages/(agent-definition|agent-cognition)/' },
      to: {
        path: '(^packages/(persistence|event-system|event-store)/|^@maoeh/(persistence|event-system|event-store)(/|$))',
      },
    },
    {
      name: 'orchestration-no-llm',
      severity: 'error',
      comment: 'F7/F12: orchestration packages must not import llm-gateway or agent-cognition',
      from: { path: `^packages/(${orchestrationPackages.join('|')})/` },
      to: {
        path: '(^packages/(llm-gateway|agent-cognition)/|^@maoeh/(llm-gateway|agent-cognition)(/|$))',
      },
    },
    {
      name: 'single-llm-egress',
      severity: 'error',
      comment: 'F6: provider SDKs only allowed in packages/llm-gateway',
      from: { pathNot: '^packages/llm-gateway/' },
      to: {
        path: '(^|/)(openai|@anthropic-ai/sdk|@google/generative-ai|ollama)(/|$)',
      },
    },
    {
      name: 'event-mechanism-pure',
      severity: 'error',
      comment: 'F11: event-system must not import persistence',
      from: { path: '^packages/event-system/' },
      to: {
        path: '(^packages/persistence/|^@maoeh/persistence(/|$))',
      },
    },
    {
      name: 'runtime-no-prompt',
      severity: 'error',
      comment: 'F8: agent-runtime must not import agent-cognition prompts',
      from: { path: '^packages/agent-runtime/' },
      to: {
        path: '(^packages/agent-cognition/.*[Pp]rompt|^@maoeh/agent-cognition/.*[Pp]rompt)',
      },
    },
    {
      name: 'control-plane-pure',
      severity: 'error',
      comment:
        'ADR-013: organization-control is neither a Runtime nor a Cognition layer, and must not reach persistence/LLM directly',
      from: { path: '^packages/organization-control/' },
      to: {
        path: '(^packages/(llm-gateway|agent-cognition|agent-runtime|persistence)/|^@maoeh/(llm-gateway|agent-cognition|agent-runtime|persistence)(/|$))',
      },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    // Generated preview workspaces are data, not source; the reaper/API can remove them while a
    // scan is running, and a missing file must not fail the architecture gate.
    exclude: { path: '(^|/)(\\.maoeh|\\.turbo|\\.screenshots)(/|$)' },
    doNotFollow: { path: '(^|/)(dist|node_modules)(/|$)' },
  },
};
