import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const controlRoot = join(root, 'packages/organization-control/src');
const kernelControlRoot = join(root, 'apps/kernel/src/control');

const skipDirs = new Set(['node_modules', 'dist', '.turbo', '.git']);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, acc);
    else if (extname(entry.name) === '.ts') acc.push(fullPath);
  }
  return acc;
}

function sourcesOf(dir: string): readonly { readonly file: string; readonly source: string }[] {
  return walk(dir).map((file) => ({
    file: relative(root, file).replace(/\\/g, '/'),
    source: readFileSync(file, 'utf8'),
  }));
}

const controlSources = sourcesOf(controlRoot);
const kernelControlSources = sourcesOf(kernelControlRoot);
const combined = controlSources.map((entry) => entry.source).join('\n');
const kernelCombined = kernelControlSources.map((entry) => entry.source).join('\n');

const registryText = readFileSync(join(root, 'docs/architecture/package-registry.md'), 'utf8');

describe('M1.0 architecture boundary: Organization Control Plane (ADR-013)', () => {
  it('scans non-empty sources (guard never idles)', () => {
    expect(controlSources.length).toBeGreaterThan(0);
    expect(kernelControlSources.length).toBeGreaterThan(0);
  });

  it('C2: control plane never imports llm-gateway, agent-cognition, agent-runtime or persistence', () => {
    for (const forbidden of [
      '@maoeh/llm-gateway',
      '@maoeh/agent-cognition',
      '@maoeh/agent-runtime',
      '@maoeh/agent-definition',
      '@maoeh/persistence',
      'openai',
      '@anthropic-ai/sdk',
      'node:http',
      'node:net',
    ]) {
      expect(combined, forbidden).not.toContain(forbidden);
    }
    // No relative escape into another workspace (F1: packages/* never depends on apps/*).
    expect(combined).not.toMatch(/from\s+['"][^'"]*\.\.\/apps\//);
    expect(combined).not.toMatch(/from\s+['"][^'"]*\.\.\/\.\.\/apps\//);
  });

  it('C2: control plane never imports another app (F1: packages/* never depends on apps/*)', () => {
    expect(combined).not.toContain('@maoeh/kernel');
    expect(combined).not.toContain('@maoeh/api');
    expect(combined).not.toContain('@maoeh/projector');
    expect(combined).not.toContain('@maoeh/web');
  });

  it('C1: control plane never assigns to simulation/agent/workflow/task state fields', () => {
    // Direct state mutation smells. The Control Plane must drive domain operations only.
    //
    // Note: a naive `.status =` scan also matches the read-only comparison `===`, so the
    // assignment check is regex-based and excludes equality operators.
    const assignment = /\.(status|presence|version|paused|state|currentCycleId)\s*=(?!=)/;
    for (const entry of [...controlSources, ...kernelControlSources]) {
      expect(assignment.test(entry.source), `${entry.file}: state assignment`).toBe(false);
    }
    for (const forbidden of [
      '.instanceStore.save(',
      '.taskStore.save(',
      '.stateStore.commit(',
      'WorkflowState',
      'TaskState[',
    ]) {
      expect(combined, forbidden).not.toContain(forbidden);
    }
  });

  it('C3: control plane has no admin bypass branch', () => {
    for (const forbidden of ['isAdmin', 'is_admin', 'SUPERUSER', 'bypassAuth', 'skipAuthz']) {
      expect(combined, forbidden).not.toContain(forbidden);
    }
    // It must delegate to the existing AuthzService instead.
    expect(combined).toContain('authz.can(');
    expect(combined).toContain('validateActorLegitimacy');
  });

  it('C4: control plane writes only through the event store append port', () => {
    expect(combined).toContain('eventStore.append(');
    for (const forbidden of ['pg.', 'Pool(', 'createPool', 'sql`', 'rawQuery']) {
      expect(combined, forbidden).not.toContain(forbidden);
    }
  });

  it('C5: commands are never emitted as past-tense control events', () => {
    // `Simulation.Pause` is a command; `Control.SimulationPaused` is the event.
    for (const commandLikeEvent of [
      "'Simulation.Pause'",
      "'Simulation.Resume'",
      "'Agent.Pause'",
      "'Workflow.Cancel'",
    ]) {
      expect(combined, commandLikeEvent).toContain(commandLikeEvent);
    }
    for (const eventType of [
      "'Control.SimulationPaused'",
      "'Control.SimulationResumed'",
      "'Control.AgentPaused'",
    ]) {
      expect(combined, eventType).toContain(eventType);
    }
  });

  it('C9: agent pause and simulation pause are distinct concepts in the source', () => {
    expect(combined).toContain('setAgentPaused');
    expect(combined).toContain('simulation.pause()');
    expect(combined).toContain('AGENT_PAUSED');
    expect(combined).toContain('SIMULATION_PAUSED');
  });

  it('the control plane only drives the simulation through the injected port', () => {
    const service = controlSources.find((entry) => entry.file.endsWith('service.ts'));
    expect(service).toBeDefined();
    expect(service?.source).toContain('ControlSimulationPort');
    expect(service?.source).not.toContain('import type { Simulation }');
  });

  it('registry lists organization-control as a package with the ADR-013 boundaries', () => {
    expect(registryText).toContain('### organization-control');
    const start = registryText.indexOf('### organization-control\n');
    expect(start).toBeGreaterThan(-1);
    const next = registryText.indexOf('\n### ', start + 1);
    const section = registryText.slice(start, next < 0 ? registryText.length : next);
    expect(section).toContain('llm-gateway');
    expect(section).toContain('agent-cognition');
    expect(section).toContain('agent-runtime');
    expect(section).toContain('Layer**：Application');
    expect(section).toContain('audit-system');
  });

  it('dependency-cruiser enforces the control-plane-pure rule', () => {
    const cruiser = readFileSync(join(root, '.dependency-cruiser.mjs'), 'utf8');
    expect(cruiser).toContain('control-plane-pure');
    expect(cruiser).toContain('organization-control');
  });

  it('baseline and dependency graph record the ADR-013 change', () => {
    const baseline = readFileSync(join(root, 'docs/architecture/ARCHITECTURE-BASELINE.md'), 'utf8');
    const graph = readFileSync(join(root, 'docs/architecture/dependency-graph.md'), 'utf8');
    const adr = readFileSync(join(root, 'docs/architecture/08-adr.md'), 'utf8');
    expect(baseline).toContain('Organization Control Plane');
    expect(baseline).toContain('ADR-013');
    expect(graph).toContain('organization-control');
    expect(adr).toContain('ADR-013');
  });

  it('no separate simulation-engine or control-engine package was introduced', () => {
    const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(packages).toContain('organization-control');
    expect(packages).not.toContain('simulation-engine');
    expect(packages).not.toContain('control-engine');
    expect(packages).not.toContain('control-plane');
  });

  it('C10: audit stays a log — the control plane never treats it as the event source of truth', () => {
    // It may read the audit trail for idempotency and the query API, but every domain
    // effect must be found in the event store, not replayed from audit.
    expect(combined).toContain('audit.record(');
    expect(combined).toContain('audit.find(');
    expect(combined).not.toContain('audit.replay(');
  });

  it('kernel only reaches the control plane through the composition root', () => {
    expect(kernelCombined).toContain('createControlService');
    expect(kernelCombined).toContain('ControlSimulationPort');
    // The kernel must not gain an LLM or cognition dependency through this path.
    expect(kernelCombined).not.toContain('@maoeh/llm-gateway');
  });
});
