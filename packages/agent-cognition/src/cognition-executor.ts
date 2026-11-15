import type { Result } from '@maoeh/shared-types';
import { createCallBudget } from '@maoeh/llm-gateway';
import type { LlmGateway } from '@maoeh/llm-gateway';
import type { CognitionError } from './cognition-errors.js';
import { cognitionError, cognitionIssue, mapLlmError } from './cognition-errors.js';
import type { CognitionRequest } from './cognition-request.js';
import type { CognitionResult } from './cognition-result.js';
import { buildPlan } from './planning/planner.js';
import { buildCognitionPrompt } from './prompts/cognition.js';
import { buildSystemPrompt } from './prompts/system.js';
import { buildReasoning } from './reasoning/reasoning.js';
import { cognitionOutputSchema } from './schemas/cognition-output.js';

export interface CognitionExecutorOptions {
  readonly gateway: LlmGateway;
}

export interface CognitionExecutor {
  execute(request: CognitionRequest): Promise<Result<CognitionResult, CognitionError>>;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const withoutOpening = trimmed.replace(/^```[A-Za-z]*[ \t]*\r?\n?/, '');
  return withoutOpening.replace(/\r?\n?[ \t]*```$/, '').trim();
}

const CONTROL_NAMES: Readonly<Record<number, string>> = {
  10: '\\n',
  13: '\\r',
  9: '\\t',
};

/**
 * DeepSeek-flash (and many other live providers) systematically emit raw control characters
 * inside string literals — most often real newlines in a multi-line `content`/`product_requirement`.
 * Strict `JSON.parse` refuses those, and the deterministic cognition layer then fails the whole
 * plan with `malformed_output` even though the model's JSON object shape is otherwise fine.
 *
 * Scan the text once, escape control characters that sit inside a string literal, and leave
 * everything else untouched. Escaped backslashes are tracked so an `\\\n` pair is untouched,
 * and only characters strictly inside a quoted string are rewritten (control characters are legal
 * JSON whitespace outside strings).
 */
function escapeControlCharsInsideStrings(raw: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (escape) {
      escape = false;
      out += raw[index];
      continue;
    }
    if (code === 0x5c /* backslash */) {
      escape = true;
      out += raw[index];
      continue;
    }
    if (code === 0x22 /* double quote */) {
      inString = !inString;
      out += raw[index];
      continue;
    }
    if (inString && code < 0x20) {
      out += Object.prototype.hasOwnProperty.call(CONTROL_NAMES, code)
        ? CONTROL_NAMES[code]!
        : `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += raw[index];
  }
  return out;
}

function parseOutput(
  text: string,
): Result<Record<string, unknown>, CognitionError> {
  const raw = stripFences(text);
  if (raw === '') {
    return {
      ok: false,
      error: cognitionIssue('malformed_output', 'response.text', 'provider returned no content'),
    };
  }
  const attempt = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      return undefined;
    }
  };
  const direct = attempt(raw);
  if (direct !== undefined) {
    return finalize(direct);
  }
  const repaired = escapeControlCharsInsideStrings(raw);
  if (repaired !== raw) {
    const secondPass = attempt(repaired);
    if (secondPass !== undefined) {
      return finalize(secondPass);
    }
  }
  return {
    ok: false,
    error: cognitionIssue(
      'malformed_output',
      'response.text',
      'response is not valid JSON',
    ),
  };
}

/**
 * Live models add harmless extra keys (`steps_notes`, `confidence_reason`) and occasionally omit
 * the non-semantic `reasonRef` audit index. Dropping unknown keys and defaulting only that index
 * is shape normalisation, not a structural repair: required semantic fields are still validated
 * by the schema below, and a missing goal/action/steps still fails.
 */
function normalizeOutputShape(parsed: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ['interpretation', 'considerations', 'conclusion', 'confidence'] as const) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) output[key] = parsed[key];
  }
  const plan = parsed['plan'];
  if (typeof plan === 'object' && plan !== null && !Array.isArray(plan)) {
    const source = plan as Record<string, unknown>;
    const normalizedPlan: Record<string, unknown> = {};
    for (const key of ['goal', 'doneWhen'] as const) {
      if (Object.prototype.hasOwnProperty.call(source, key)) normalizedPlan[key] = source[key];
    }
    const steps = source['steps'];
    normalizedPlan['steps'] = Array.isArray(steps)
      ? steps.map((step) => {
          if (typeof step !== 'object' || step === null || Array.isArray(step)) return step;
          const entry = step as Record<string, unknown>;
          return {
            action: entry['action'],
            args:
              typeof entry['args'] === 'object' && entry['args'] !== null && !Array.isArray(entry['args'])
                ? entry['args']
                : {},
            reasonRef:
              typeof entry['reasonRef'] === 'number' && Number.isInteger(entry['reasonRef'])
                ? entry['reasonRef']
                : 0,
          };
        })
      : steps;
    output['plan'] = normalizedPlan;
  } else {
    output['plan'] = plan;
  }
  return output;
}

function finalize(
  parsed: unknown,
): Result<Record<string, unknown>, CognitionError> {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: cognitionIssue('malformed_output', 'response.text', 'response JSON must be an object'),
    };
  }
  return { ok: true, value: normalizeOutputShape(parsed as Record<string, unknown>) };
}

function validateRequest(request: CognitionRequest): CognitionError | null {
  if (request.requestId.trim() === '') {
    return cognitionIssue('invalid_request', 'requestId', 'requestId must not be empty');
  }
  if (request.actorContext === undefined || request.actorContext === null) {
    return cognitionIssue(
      'missing_actor_context',
      'actorContext',
      'cognition refuses to call a provider without an ActorContext (A4)',
    );
  }
  if (request.cognitionContext === undefined || request.cognitionContext === null) {
    return cognitionIssue('invalid_context', 'cognitionContext', 'context must not be missing');
  }
  if (request.actorContext.employeeId !== request.cognitionContext.agent.employeeId) {
    return cognitionIssue(
      'missing_actor_context',
      'actorContext.employeeId',
      'actor does not match the cognitive agent',
    );
  }
  if (request.profile.id !== request.cognitionContext.definition.cognitionProfileId) {
    return cognitionIssue(
      'invalid_profile',
      'profile.id',
      `profile "${request.profile.id}" does not match profile id "${request.cognitionContext.definition.cognitionProfileId}"`,
    );
  }
  if (!Number.isInteger(request.maxLlmCalls) || request.maxLlmCalls < 0) {
    return cognitionIssue(
      'invalid_request',
      'maxLlmCalls',
      'maxLlmCalls must be a non-negative integer',
    );
  }
  return null;
}

export function createCognitionExecutor(options: CognitionExecutorOptions): CognitionExecutor {
  const { gateway } = options;

  return {
    async execute(request) {
      const requestFailure = validateRequest(request);
      if (requestFailure !== null) return { ok: false, error: requestFailure };

      const { actorContext, cognitionContext, profile, requestId } = request;
      const budget = createCallBudget(request.maxLlmCalls);

      const llmResult = await gateway.generate({
        actorContext,
        request: {
          requestId,
          system: buildSystemPrompt(cognitionContext.definition, profile, {
            canDispatchWork: cognitionContext.workCatalog?.canDispatchWork === true,
          }),
          prompt: buildCognitionPrompt(cognitionContext),
          // Cognition always wants a JSON object, and the system prompt already contains the word
          // "json" plus a shape example, so a JSON-capable provider can enforce it at the
          // protocol level. The schema check below still owns validation.
          responseFormat: 'json',
          ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
        },
        budget,
      });

      if (!llmResult.ok) return { ok: false, error: mapLlmError(llmResult.error) };

      const response = llmResult.value;
      if (response.text !== undefined) console.error(`[llm-raw] agent=${request.cognitionContext.definition.id}\n${response.text}`);
      const objectResult = parseOutput(response.text);
      if (!objectResult.ok) return { ok: false, error: objectResult.error };

      const schemaResult = cognitionOutputSchema.safeParse(objectResult.value);
      if (!schemaResult.success) {
        return {
          ok: false,
          error: cognitionError(
            'schema_violation',
            schemaResult.error.issues.map((issue) => ({
              field: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
              reason: issue.message,
            })),
          ),
        };
      }

      const draft = schemaResult.data;
      const reasoningResult = buildReasoning(draft);
      if (!reasoningResult.ok) return { ok: false, error: reasoningResult.error };
      const reasoning = reasoningResult.value;

      const planResult = buildPlan({
        draft: draft.plan,
        considerationsCount: reasoning.considerations.length,
        idempotencySeed: requestId,
      });
      if (!planResult.ok) return { ok: false, error: planResult.error };

      return {
        ok: true,
        value: {
          requestId,
          interpretation: draft.interpretation.trim(),
          reasoning,
          plan: planResult.value,
          confidence: draft.confidence,
          llmMetadata: {
            provider: response.provider,
            model: response.model,
            latencyMs: response.latencyMs,
            inputTokens: response.inputTokens ?? 0,
            outputTokens: response.outputTokens ?? 0,
            callCount: budget.callCount,
          },
        },
      };
    },
  };
}
