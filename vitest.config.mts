import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

const appSource = (name: string): string =>
  fileURLToPath(new URL(`./apps/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@maoeh/shared-types': packageSource('shared-types'),
      '@maoeh/organization-model': packageSource('organization-model'),
      '@maoeh/identity-system': packageSource('identity-system'),
      '@maoeh/event-system': packageSource('event-system'),
      '@maoeh/event-store': packageSource('event-store'),
      '@maoeh/permission-system': packageSource('permission-system'),
      '@maoeh/authority-engine': packageSource('authority-engine'),
      '@maoeh/task-system': packageSource('task-system'),
      '@maoeh/workflow-engine': packageSource('workflow-engine'),
      '@maoeh/agent-communication': packageSource('agent-communication'),
      '@maoeh/runtime-state': packageSource('runtime-state'),
      '@maoeh/runtime-scheduler': packageSource('runtime-scheduler'),
      '@maoeh/agent-definition': packageSource('agent-definition'),
      '@maoeh/agent-cognition': packageSource('agent-cognition'),
      '@maoeh/agent-runtime': packageSource('agent-runtime'),
      '@maoeh/llm-gateway': packageSource('llm-gateway'),
      '@maoeh/observability': packageSource('observability'),
      '@maoeh/audit-system': packageSource('audit-system'),
      '@maoeh/knowledge-system': packageSource('knowledge-system'),
      '@maoeh/artifact-system': packageSource('artifact-system'),
      '@maoeh/organization-control': packageSource('organization-control'),
      '@maoeh/kernel': appSource('kernel'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', '**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 60000,
  },
});
