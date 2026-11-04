import type { Result } from '@maoeh/shared-types';
import type { LlmError } from './errors.js';
import type { LlmRequest } from './request.js';
import type { LlmResponse } from './response.js';

export interface LlmProvider {
  readonly name: string;
  generate(request: LlmRequest): Promise<Result<LlmResponse, LlmError>>;
}
