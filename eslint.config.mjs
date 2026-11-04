import tseslint from 'typescript-eslint';
import js from '@eslint/js';

const providerBan = {
  patterns: [
    {
      group: ['openai', 'openai/*', '@anthropic-ai/sdk', '@anthropic-ai/sdk/*', '@google/generative-ai', '@google/generative-ai/*', 'ollama', 'ollama/*'],
      message: 'F6: LLM provider SDKs are only allowed in packages/llm-gateway (single egress).',
    },
  ],
};

const persistenceBan = {
  paths: [
    { name: '@maoeh/persistence', message: '§5.2: @maoeh/persistence may only be imported by registry-allowed packages.' },
  ],
};

const allMaoehBan = {
  patterns: [
    {
      group: ['@maoeh/*'],
      message: 'F2: apps/web must not import any @maoeh/* backend package.',
    },
  ],
};

const persistenceAllowedFiles = [
  'packages/agent-memory/**',
  'packages/runtime-state/**',
  'packages/runtime-scheduler/**',
  'packages/event-store/**',
  'packages/knowledge-system/**',
  'packages/artifact-system/**',
  'packages/audit-system/**',
  'packages/observability/**',
  'apps/kernel/**',
  'apps/api/**',
  'apps/projector/**',
];

export default tseslint.config(
  {
    // `.maoeh/` is the runtime's own state directory (the durable event log and anything the
    // kernel materialises next to it). It is generated data — same class as `dist/` and
    // `.turbo/` — and it may be created or removed while the console is running, so linting it
    // is both meaningless and racy (ESLint's globber can hit ENOENT mid-run).
    //
    // `.tmp-diag/` is the local diagnostic scratch area: one-off probes, captured reports and
    // evidence written while investigating a runtime problem. Same class of content — generated,
    // not shipped, imported by nothing — and a probe is written to be run once and read. The
    // one-shot tools worth keeping are promoted into `scripts/`, where the Node globals below
    // apply.
    ignores: ['**/dist/**', '**/node_modules/**', '.turbo/**', '.maoeh/**', '.tmp-diag/**'],
  },
  {
    files: [
      'scripts/**/*.mjs',
      'scripts/**/*.js',
      '*.config.mjs',
      '*.config.cjs',
      '*.config.mts',
      // The browserless E2E driver talks to Chrome over CDP using Node's own globals.
      'tests/e2e/**/*.mjs',
    ],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': ['error', { ...providerBan, ...persistenceBan }],
    },
  },
  {
    files: ['packages/llm-gateway/**'],
    rules: {
      'no-restricted-imports': ['error', { ...persistenceBan }],
    },
  },
  {
    files: persistenceAllowedFiles,
    rules: {
      'no-restricted-imports': ['error', { ...providerBan }],
    },
  },
  {
    files: ['apps/web/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-imports': ['error', { ...providerBan, ...allMaoehBan }],
    },
  },
);
