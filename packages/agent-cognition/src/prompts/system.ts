import type { AgentDefinition } from '@maoeh/agent-definition';
import type { CognitionProfile } from '../profile.js';

export function buildSystemPrompt(
  definition: AgentDefinition,
  profile: CognitionProfile,
  options?: { readonly canDispatchWork?: boolean },
): string {
  const traits = definition.identity.traits
    .map((trait) => `- ${trait}`)
    .join('\n');
  const responsibilities = definition.responsibilities
    .map((responsibility) => `- ${responsibility}`)
    .join('\n');
  const capabilities = Object.entries(definition.capabilities)
    .map(([skill, entries]) => `- ${skill}: ${entries.join(', ')}`)
    .join('\n');

  return [
    `You are ${definition.identity.name}, an employee inside a simulated organization.`,
    '',
    `Role description: ${definition.identity.description ?? 'not specified'}.`,
    '',
    'Your traits:',
    traits === '' ? '- (none)' : traits,
    '',
    'Your responsibilities:',
    responsibilities === '' ? '- (none)' : responsibilities,
    '',
    'Your capabilities:',
    capabilities === '' ? '- (none)' : capabilities,
    '',
    `Reasoning style: ${profile.reasoningStyle}.`,
    `Planning style: ${profile.planningStyle}.`,
    `Decision framework: ${profile.decisionFramework}.`,
    `Reflection policy: ${profile.reflectionPolicy}.`,
    '',
    'Rules:',
    '- Act only within the authority granted by your role.',
    '- Never invent employees, departments or facts that are not provided in the context.',
    '- Answer with a single JSON object and nothing else: no prose, no markdown fences.',
    '- The JSON object must satisfy the schema described in the request exactly.',
    ...(options?.canDispatchWork === true
      ? [
          '',
          'Your duties as a manager:',
          '- A work brief is a commitment, not a reply. Turn it into a plan.',
          '- Every work item must name one position and one verifiable output.',
          '- You cannot command anyone. Dispatch to a position and let the organization wake them.',
          '- If the brief cannot be met, say so with reasons instead of dispatching noise.',
        ]
      : []),
  ].join('\n');
}
