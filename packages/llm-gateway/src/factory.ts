import type { Result } from '@maoeh/shared-types';
import type { LlmConfigError, LlmConfigIssue, LlmGatewayConfig, LlmProviderConfig } from './config.js';
import type { LlmGateway } from './gateway.js';
import { createLlmGateway } from './gateway.js';
import type { LlmProvider } from './provider.js';
import { createOpenAiCompatibleProvider } from './providers/openai-compatible-provider.js';

export interface LlmGatewayFromConfigDeps {
  /**
   * Builds the deterministic mock provider. The application owns this because the text a mock
   * answers with is domain content — `apps/api` derives it from the prompt so the console shows a
   * running organization rather than an empty plan. Injecting it also keeps this package free of
   * application imports.
   */
  readonly createMockProvider: (config: LlmProviderConfig) => LlmProvider;
  /**
   * Clock behind the ledger's `startedAt`/`latencyMs`. Injected so a composed runtime keeps the
   * deterministic timestamps it had before configuration existed.
   */
  readonly now?: () => number;
}

/** `null` means "this kind is not something we can build", never "fall back to the mock". */
function providerFor(
  pConfig: LlmProviderConfig,
  pDeps: LlmGatewayFromConfigDeps,
): LlmProvider | null {
  switch (pConfig.kind) {
    case 'mock':
      return pDeps.createMockProvider(pConfig);
    case 'openai-compatible':
      return createOpenAiCompatibleProvider({ config: pConfig });
    default:
      return null;
  }
}

/**
 * Turn a validated config into a wired gateway.
 *
 * Nothing here silently degrades: an unsupported provider kind or a `defaultProvider` that names
 * no provider is a configuration error, because the alternative — answering from the mock when a
 * live model was asked for — is indistinguishable from success at every layer above.
 */
export function createLlmGatewayFromConfig(
  pConfig: LlmGatewayConfig,
  pDeps: LlmGatewayFromConfigDeps,
): Result<LlmGateway, LlmConfigError> {
  const issues: LlmConfigIssue[] = [];
  const providers: LlmProvider[] = [];

  for (const providerConfig of pConfig.providers) {
    const provider = providerFor(providerConfig, pDeps);
    if (provider === null) {
      issues.push({
        field: 'providers',
        reason: `unsupported provider kind "${String(providerConfig.kind)}"`,
      });
      continue;
    }
    providers.push(provider);
  }

  const defaultConfig = pConfig.providers.find(
    (candidate) => candidate.id === pConfig.defaultProvider,
  );
  if (defaultConfig === undefined) {
    issues.push({
      field: 'defaultProvider',
      reason: `"${pConfig.defaultProvider}" does not name any configured provider`,
    });
  }

  if (issues.length > 0) {
    return { ok: false, error: { code: 'invalid_config', issues } };
  }

  return {
    ok: true,
    value: createLlmGateway({
      providers,
      defaultProvider: pConfig.defaultProvider,
      // The gateway applies one timeout to whichever provider it calls, so the default
      // provider's value is the one that governs. Per-provider timeouts need a gateway change
      // rather than a config change.
      ...(defaultConfig === undefined ? {} : { timeoutMs: defaultConfig.timeoutMs }),
      maxAttempts: pConfig.maxAttempts,
      ...(pDeps.now === undefined ? {} : { now: pDeps.now }),
    }),
  };
}
