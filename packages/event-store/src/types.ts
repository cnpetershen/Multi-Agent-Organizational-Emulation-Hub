import type { Brand, CompanyId, OrgEvent } from '@maoeh/shared-types';

declare const eventStoreTransaction: unique symbol;

export type EventStoreTransaction = { readonly [eventStoreTransaction]: 'EventStoreTransaction' };

export type Seq = Brand<number, 'Seq'>;

export interface EventFilter {
  readonly companyId?: CompanyId;
  readonly type?: string;
  readonly correlationId?: string;
  readonly subjectId?: string;
}

export interface OutboxEntry {
  readonly id: number;
  readonly eventId: string;
  readonly topic: string;
  readonly payload: OrgEvent;
  readonly availableAt: string;
  readonly dispatchedAt: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

export interface OutboxDispatchReport {
  readonly dispatched: number;
  readonly failed: number;
}

export interface ConsumerOffset {
  readonly consumerGroup: string;
  readonly companyId: CompanyId;
  readonly lastSeq: Seq;
}

export interface ProcessedRecord {
  readonly consumerGroup: string;
  readonly eventId: string;
  readonly consumerKey: string;
  readonly processedAt: string;
}

export class DuplicateEventError extends Error {
  readonly eventId: string;
  readonly companyId: string;

  constructor(eventId: string, companyId: string) {
    super(`duplicate event ${eventId} for company ${companyId}`);
    this.name = 'DuplicateEventError';
    this.eventId = eventId;
    this.companyId = companyId;
  }
}

export interface EventStore {
  append(events: readonly OrgEvent[], tx?: EventStoreTransaction): Promise<Seq>;
  replay(from: Seq, to?: Seq, filter?: EventFilter): AsyncIterable<OrgEvent>;
  dispatchOutbox(handler: (entry: OutboxEntry) => Promise<void>): Promise<OutboxDispatchReport>;
  commitOffset(consumerGroup: string, companyId: CompanyId, lastSeq: Seq): void;
  loadOffset(consumerGroup: string, companyId: CompanyId): Seq;
  markProcessed(consumerGroup: string, eventId: string, consumerKey: string): void;
  isProcessed(consumerGroup: string, eventId: string, consumerKey: string): boolean;
}
