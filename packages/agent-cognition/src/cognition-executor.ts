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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: cognitionIssue(
        'malformed_output',
        'response.text',
        error instanceof Error ? error.message : 'response is not valid JSON',
      ),
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: cognitionIssue('malformed_output', 'response.text', 'response JSON must be an object'),
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
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
