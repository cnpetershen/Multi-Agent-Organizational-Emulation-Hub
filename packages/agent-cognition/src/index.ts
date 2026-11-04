export type {
  CognitionErrorCode,
  CognitionError,
  CognitionIssue,
} from './cognition-errors.js';
export { cognitionError, cognitionIssue, mapLlmError } from './cognition-errors.js';

export type {
  CapabilityOfferView,
  CapabilitySeatView,
  CognitionAgentRef,
  CognitionContext,
  CognitionStateView,
  OrgMemberView,
  OrganizationSnapshotView,
  WorkCatalogView,
} from './context/cognition-context.js';
export type { BuildCognitionContextInput } from './context/build-context.js';
export { buildCognitionContext } from './context/build-context.js';

export type { CognitionRequest } from './cognition-request.js';
export type {
  CognitionLlmMetadata,
  CognitionResult,
  ReasoningResult,
} from './cognition-result.js';

export type { CognitionExecutor, CognitionExecutorOptions } from './cognition-executor.js';
export { createCognitionExecutor } from './cognition-executor.js';

export type { ReasoningDraft } from './reasoning/reasoning.js';
export { buildReasoning } from './reasoning/reasoning.js';
export type { BuildPlanInput } from './planning/planner.js';
export { buildPlan } from './planning/planner.js';

export type {
  CognitionOutputDraft,
  CognitionPlanDraft,
  CognitionStepDraft,
} from './schemas/cognition-output.js';
export {
  cognitionOutputSchema,
  cognitionPlanSchema,
  cognitionStepSchema,
} from './schemas/cognition-output.js';

export type { CognitionProfile, CognitionProfileSource, CognitionSourceReader } from './profile.js';
export { cognitionProfileSourceSchema } from './profile.js';
export type {
  CognitionProfileIssue,
  CognitionProfileFailure,
  LoadCognitionProfilesOptions,
} from './load-cognition-profiles.js';
export { loadCognitionProfiles } from './load-cognition-profiles.js';
