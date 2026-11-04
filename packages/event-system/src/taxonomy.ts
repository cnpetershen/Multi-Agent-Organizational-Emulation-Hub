export const EVENT_AGGREGATES = [
  'Organization',
  'Employee',
  'Relationship',
  'Communication',
  'Meeting',
  'Task',
  'Workflow',
  'Decision',
  'Memory',
  'Document',
  'Tool',
  'Runtime',
  'System',
  'Control',
] as const;

export type EventAggregate = (typeof EVENT_AGGREGATES)[number];

const EVENT_TYPE_PATTERN = /^[A-Z][A-Za-z0-9]*\.[A-Z][A-Za-z0-9]*$/;

export interface ParsedEventType {
  readonly aggregate: EventAggregate;
  readonly event: string;
}

export function parseEventType(type: string): ParsedEventType | null {
  if (!EVENT_TYPE_PATTERN.test(type)) return null;
  const separator = type.indexOf('.');
  const aggregate = type.slice(0, separator);
  if (!(EVENT_AGGREGATES as readonly string[]).includes(aggregate)) return null;
  return { aggregate: aggregate as EventAggregate, event: type.slice(separator + 1) };
}
