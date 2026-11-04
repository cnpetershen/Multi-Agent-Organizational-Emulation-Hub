export type {
  AuthorizeCommunicationInput,
  AuthorizedSend,
  CreateChannelInput,
  CreateChannelResult,
  DeliverMessageInput,
  ReadMessageInput,
  ReadMessageResult,
  ResolveRecipientsInput,
  SendMessageInput,
  SendMessageResult,
} from './communication-types.js';
export type {
  CommunicationErrorCode,
  CommunicationFailure,
  CommunicationIssue,
  DeniedDecision,
} from './communication-errors.js';
export {
  communicationFailure,
  failure,
  issue,
  permissionFailure,
} from './communication-errors.js';
export type {
  CommunicationService,
  CommunicationServiceDeps,
  CommunicationServiceOptions,
} from './communication-service.js';
export { createCommunicationService } from './communication-service.js';
export type {
  AuthorizerDeps,
} from './authorization/communication-authorizer.js';
export { authorizeCommunication, authorizeRead } from './authorization/communication-authorizer.js';
export { actorContextSchema, validateActorContext } from './authorization/actor-context.js';
export type { Channel, ChannelStatus, ChannelType } from './channels/channel.js';
export { CHANNEL_STATUSES, CHANNEL_TYPES, closeChannel, createChannel } from './channels/channel.js';
export {
  channelMemberIds,
  countChannelMembers,
  isChannelMember,
} from './channels/channel-membership.js';
export { channelDraftSchema } from './channels/channel-validation.js';
export type { DeliveryRecord } from './delivery/delivery.js';
export { createDeliveryRecord, deliveryIdempotencyKey } from './delivery/delivery.js';
export type { DeliveryResult, DeliveryStatus } from './delivery/delivery-result.js';
export { DELIVERY_STATUSES, createDeliveryResult } from './delivery/delivery-result.js';
export type {
  ChannelOpenedPayload,
  CollaborationRequestedPayload,
  MessageSentPayload,
} from './events/communication-events.js';
export {
  COMMUNICATION_CHANNEL_OPENED,
  COMMUNICATION_COLLABORATION_REQUESTED,
  COMMUNICATION_MESSAGE_SENT,
  channelOpenedPayloadSchema,
  collaborationRequestedPayloadSchema,
  isChannelOpenedEvent,
  isCollaborationRequestedEvent,
  isMessageSentEvent,
  messageSentPayloadSchema,
  registerCommunicationEvents,
} from './events/communication-events.js';
export type {
  CommunicationIdentity,
  IdentityResolutionFailure,
  ResolvedIdentity,
} from './identity/communication-identity.js';
export { createResolvedIdentity } from './identity/communication-identity.js';
export type { Message } from './messages/message.js';
export { createMessage, messageSenderId } from './messages/message.js';
export type { MessageType } from './messages/message-type.js';
export { MESSAGE_TYPES } from './messages/message-type.js';
export {
  MESSAGE_LIMITS,
  messageDraftSchema,
  recipientIdsSchema,
} from './messages/message-validation.js';
export type {
  ChannelStore,
  DeliveryStore,
  MessageStore,
} from './stores/stores.js';
export type {
  CollaborationRecord,
  CollaborationService,
  CollaborationServiceDeps,
  CollaborationServiceOptions,
  CollaborationStore,
  CreateCollaborationRecordInput,
  RequestCollaborationInput,
  RequestCollaborationResult,
} from './collaboration/collaboration.js';
export {
  COLLABORATION_ACTION,
  COLLABORATION_RESOURCE_ID,
  collaborationFromEvent,
  createCollaborationRecord,
  createCollaborationService,
  createInMemoryCollaborationStore,
} from './collaboration/collaboration.js';
export {
  COLLABORATION_LIMITS,
  collaborationRequestDraftSchema,
} from './collaboration/collaboration-validation.js';
export type { CollaborationRequestDraft } from './collaboration/collaboration-validation.js';
export {
  createInMemoryChannelStore,
  createInMemoryDeliveryStore,
  createInMemoryMessageStore,
} from './stores/stores.js';
export { ID_LIMITS, channelIdSchema, employeeIdSchema, messageIdSchema } from './validation/ids.js';
export { zodIssues } from './validation/zod-issues.js';
