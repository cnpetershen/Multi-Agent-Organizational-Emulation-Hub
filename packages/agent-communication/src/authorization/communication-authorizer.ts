import type { Result } from '@maoeh/shared-types';
import type { AuthzService } from '@maoeh/permission-system';
import { channelResource, messageResource } from '@maoeh/permission-system';
import type { CommunicationFailure } from '../communication-errors.js';
import {
  communicationFailure,
  failure,
  permissionFailure,
} from '../communication-errors.js';
import type {
  AuthorizeCommunicationInput,
  AuthorizedSend,
  ReadMessageInput,
  ReadMessageResult,
} from '../communication-types.js';
import type { Channel } from '../channels/channel.js';
import { isChannelMember } from '../channels/channel-membership.js';
import type { CommunicationIdentity, ResolvedIdentity } from '../identity/communication-identity.js';
import { messageDraftSchema } from '../messages/message-validation.js';
import type { MessageStore, ChannelStore } from '../stores/stores.js';
import { validateActorContext } from './actor-context.js';
import { zodIssues } from '../validation/zod-issues.js';

export interface AuthorizerDeps {
  readonly authz: AuthzService;
  readonly identity: CommunicationIdentity;
  readonly channels: ChannelStore;
  readonly messages: MessageStore;
}

function error(failureValue: CommunicationFailure): {
  ok: false;
  error: CommunicationFailure;
} {
  return { ok: false, error: failureValue };
}

function identityMatchesActor(
  resolved: ResolvedIdentity,
  input: AuthorizeCommunicationInput,
): boolean {
  return (
    resolved.positionId === input.actor.positionId &&
    resolved.departmentId === input.actor.departmentId
  );
}

export function authorizeCommunication(
  deps: AuthorizerDeps,
  input: AuthorizeCommunicationInput,
): Result<AuthorizedSend, CommunicationFailure> {
  const actorFailure = validateActorContext(input.actor);
  if (actorFailure !== null) return error(actorFailure);

  const draft = messageDraftSchema.safeParse(input);
  if (!draft.success) {
    return error(communicationFailure('invalid_message', zodIssues(draft.error)));
  }

  if (input.actor.employeeId !== input.senderEmployeeId) {
    return error(
      failure(
        'sender_mismatch',
        'senderEmployeeId',
        `actor "${input.actor.employeeId}" cannot send as "${input.senderEmployeeId}"`,
      ),
    );
  }

  const sender = deps.identity.resolve(input.senderEmployeeId);
  if (!sender.ok) {
    return error(
      failure(
        'invalid_sender',
        'senderEmployeeId',
        `identity system cannot resolve employee "${input.senderEmployeeId}"`,
      ),
    );
  }
  if (!identityMatchesActor(sender.value, input)) {
    return error(
      failure(
        'invalid_sender',
        'senderEmployeeId',
        'sender identity does not match the actor context',
      ),
    );
  }

  const channel = deps.channels.get(input.channelId);
  if (channel === null) {
    return error(
      failure('unknown_channel', 'channelId', `channel "${input.channelId}" does not exist`),
    );
  }
  if (channel.status !== 'active') {
    return error(failure('channel_closed', 'channelId', `channel "${input.channelId}" is closed`));
  }
  if (!isChannelMember(channel, input.senderEmployeeId)) {
    return error(
      failure(
        'not_channel_member',
        'senderEmployeeId',
        `employee "${input.senderEmployeeId}" is not a member of channel "${channel.channelId}"`,
      ),
    );
  }

  const recipients = authorizeRecipients(deps, channel, input);
  if (!recipients.ok) return recipients;

  const replyFailure = authorizeReply(deps, input);
  if (replyFailure !== null) return error(replyFailure);

  const decision = deps.authz.can(input.actor, 'SendMessage', channelResource(channel.channelId));
  if (!decision.allow) {
    return error(permissionFailure('SendMessage', decision));
  }

  return { ok: true, value: { channel, recipients: recipients.value } };
}

function authorizeRecipients(
  deps: AuthorizerDeps,
  channel: Channel,
  input: AuthorizeCommunicationInput,
): Result<readonly ResolvedIdentity[], CommunicationFailure> {
  const seen = new Set<string>();
  const resolved: ResolvedIdentity[] = [];
  for (const recipientId of input.recipientIds) {
    if (seen.has(recipientId)) {
      return error(
        failure('invalid_recipient', 'recipientIds', `duplicate recipient "${recipientId}"`),
      );
    }
    seen.add(recipientId);
    if (recipientId === input.senderEmployeeId) {
      return error(
        failure(
          'invalid_recipient',
          'recipientIds',
          'sender must not be listed as its own recipient',
        ),
      );
    }
    const identity = deps.identity.resolve(recipientId);
    if (!identity.ok) {
      return error(
        failure(
          'invalid_recipient',
          'recipientIds',
          `identity system cannot resolve employee "${recipientId}"`,
        ),
      );
    }
    if (!isChannelMember(channel, recipientId)) {
      return error(
        failure(
          'recipient_not_channel_member',
          'recipientIds',
          `employee "${recipientId}" is not a member of channel "${channel.channelId}"`,
        ),
      );
    }
    resolved.push(identity.value);
  }
  return { ok: true, value: Object.freeze(resolved) };
}

function authorizeReply(
  deps: AuthorizerDeps,
  input: AuthorizeCommunicationInput,
): CommunicationFailure | null {
  if (input.replyToMessageId === undefined) return null;
  const parent = deps.messages.get(input.replyToMessageId);
  if (parent === null) {
    return failure(
      'unknown_message',
      'replyToMessageId',
      `message "${input.replyToMessageId}" does not exist`,
    );
  }
  if (parent.channelId !== input.channelId) {
    return failure(
      'invalid_message',
      'replyToMessageId',
      'reply must reference a message in the same channel',
    );
  }
  const participates =
    parent.senderEmployeeId === input.actor.employeeId ||
    parent.recipientIds.includes(input.actor.employeeId);
  if (!participates) {
    return failure(
      'not_message_recipient',
      'replyToMessageId',
      `employee "${input.actor.employeeId}" is neither the sender nor a recipient of message "${parent.messageId}"`,
    );
  }
  return null;
}

export function authorizeRead(
  deps: AuthorizerDeps,
  input: ReadMessageInput,
): Result<ReadMessageResult, CommunicationFailure> {
  const actorFailure = validateActorContext(input.actor);
  if (actorFailure !== null) return error(actorFailure);

  const reader = deps.identity.resolve(input.actor.employeeId);
  if (!reader.ok) {
    return error(
      failure(
        'invalid_actor',
        'actor.employeeId',
        `identity system cannot resolve employee "${input.actor.employeeId}"`,
      ),
    );
  }
  if (
    reader.value.positionId !== input.actor.positionId ||
    reader.value.departmentId !== input.actor.departmentId
  ) {
    return error(
      failure(
        'invalid_actor',
        'actor.employeeId',
        'reader identity does not match the actor context',
      ),
    );
  }

  const message = deps.messages.get(input.messageId);
  if (message === null) {
    return error(
      failure('unknown_message', 'messageId', `message "${input.messageId}" does not exist`),
    );
  }
  const channel = deps.channels.get(message.channelId);
  if (channel === null) {
    return error(
      failure('unknown_channel', 'channelId', `channel "${message.channelId}" does not exist`),
    );
  }
  if (!isChannelMember(channel, input.actor.employeeId)) {
    return error(
      failure(
        'not_channel_member',
        'actor.employeeId',
        `employee "${input.actor.employeeId}" is not a member of channel "${channel.channelId}"`,
      ),
    );
  }
  const participates =
    message.senderEmployeeId === input.actor.employeeId ||
    message.recipientIds.includes(input.actor.employeeId);
  if (!participates) {
    return error(
      failure(
        'not_message_recipient',
        'messageId',
        `employee "${input.actor.employeeId}" is neither the sender nor a recipient of message "${message.messageId}"`,
      ),
    );
  }

  const channelDecision = deps.authz.can(
    input.actor,
    'channel.read',
    channelResource(channel.channelId),
  );
  if (!channelDecision.allow) {
    return error(permissionFailure('channel.read', channelDecision));
  }
  const messageDecision = deps.authz.can(
    input.actor,
    'message.read',
    messageResource(channel.channelId, message.messageId),
  );
  if (!messageDecision.allow) {
    return error(permissionFailure('message.read', messageDecision));
  }

  return { ok: true, value: { message, channel } };
}
