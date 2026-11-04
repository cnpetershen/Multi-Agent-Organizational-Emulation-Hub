export interface EventContractIssue {
  readonly field: string;
  readonly reason: string;
}

export interface EventContractFailure {
  readonly issues: readonly EventContractIssue[];
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  const seen = new WeakSet<object>();
  const walk = (node: object): void => {
    if (seen.has(node)) return;
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.keys(node)) {
      const child = Reflect.get(node, key);
      if (typeof child === 'object' && child !== null) walk(child);
    }
  };
  walk(value);
  return value;
}
