import type { ActorContext, ActorKind } from '@maoeh/shared-types';

export type CommandActor =
  | { readonly kind: 'employee'; readonly context: ActorContext }
  | {
      readonly kind: 'system';
      readonly actorId: string;
      readonly correlationId: string;
    };

export function employeeActor(context: ActorContext): CommandActor {
  return { kind: 'employee', context };
}

export function systemActor(actorId: string, correlationId: string): CommandActor {
  return { kind: 'system', actorId, correlationId };
}

export function commandActorId(actor: CommandActor): string {
  return actor.kind === 'employee' ? actor.context.employeeId : actor.actorId;
}

export function commandActorKind(actor: CommandActor): ActorKind {
  return actor.kind === 'employee' ? 'employee' : 'system';
}

export function commandCorrelationId(actor: CommandActor): string {
  return actor.kind === 'employee' ? actor.context.correlationId : actor.correlationId;
}

export function commandActorContext(actor: CommandActor): ActorContext | null {
  return actor.kind === 'employee' ? actor.context : null;
}
