import type { WorkflowDefinition, WorkflowInstance } from './workflow-types.js';

export interface WorkflowDefinitionStore {
  get(workflowId: string): WorkflowDefinition | null;
  has(workflowId: string): boolean;
  save(definition: WorkflowDefinition): void;
  all(): readonly WorkflowDefinition[];
}

export interface WorkflowInstanceStore {
  get(instanceId: string): WorkflowInstance | null;
  has(instanceId: string): boolean;
  save(instance: WorkflowInstance): void;
  /** Drop a record the log has just deleted. Idempotent: an unknown id is simply gone. */
  delete(instanceId: string): void;
  all(): readonly WorkflowInstance[];
}

export function createInMemoryWorkflowDefinitionStore(
  seed: readonly WorkflowDefinition[] = [],
): WorkflowDefinitionStore {
  const definitions = new Map<string, WorkflowDefinition>();
  for (const definition of seed) definitions.set(definition.workflowId, definition);
  return {
    get(workflowId) {
      return definitions.get(workflowId) ?? null;
    },
    has(workflowId) {
      return definitions.has(workflowId);
    },
    save(definition) {
      definitions.set(definition.workflowId, definition);
    },
    all() {
      return [...definitions.values()];
    },
  };
}

export function createInMemoryWorkflowInstanceStore(
  seed: readonly WorkflowInstance[] = [],
): WorkflowInstanceStore {
  const instances = new Map<string, WorkflowInstance>();
  for (const instance of seed) instances.set(instance.instanceId, instance);
  return {
    get(instanceId) {
      return instances.get(instanceId) ?? null;
    },
    has(instanceId) {
      return instances.has(instanceId);
    },
    save(instance) {
      instances.set(instance.instanceId, instance);
    },
    delete(instanceId) {
      instances.delete(instanceId);
    },
    all() {
      return [...instances.values()];
    },
  };
}
