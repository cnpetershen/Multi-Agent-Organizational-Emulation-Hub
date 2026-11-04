export type { ResourceRef } from './resource-ref.js';
export { channelResource, messageResource, resourceRef } from './resource-ref.js';
export type { AuthzDecision, AuthzDenialReason } from './authz-decision.js';
export { ALLOW, deny, needsApproval } from './authz-decision.js';
export type {
  PermissionAuthorityThreshold,
  PermissionPolicy,
  PermissionRule,
  PermissionSubject,
} from './permission-policy.js';
export {
  denyRule,
  EMPTY_POLICY,
  employeeGrant,
  matchesResource,
  positionGrant,
} from './permission-policy.js';
export type {
  AuthzContext,
  AuthzService,
  AuthzServiceOptions,
  PermissionEntry,
  PermissionSet,
} from './authz-service.js';
export { createAuthzService } from './authz-service.js';
export type { CommandActor } from './command-actor.js';
export {
  commandActorContext,
  commandActorId,
  commandActorKind,
  commandCorrelationId,
  employeeActor,
  systemActor,
} from './command-actor.js';
export type { ActorLegitimacyIssue } from './actor-legitimacy.js';
export { validateActorLegitimacy } from './actor-legitimacy.js';
