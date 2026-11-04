import { describe, expect, it } from 'vitest';
import {
  backendLanguage,
  capabilityDelivery,
  deliveryShape,
  productSpec,
  readStepBrief,
} from '../../../apps/api/src/product-deliverables';

/**
 * The delivery contract for one step.
 *
 * The reported defect behind these tests: a workflow whose stages are `Implementation`,
 * `Frontend` and `Backend` — all routed to one seat that declares all three capabilities — handed
 * back the *same* client-side page three times. The requirement (`前端Web SPA 后端用python，
 * 后端用来记录每次排名和得分`) asked for two halves, and the delivery page showed one.
 *
 * These assertions pin what the organization now hands back per step: the step's declared
 * capability chooses the shape, and the requirement the workflow was created for decides the
 * product — so the frontend and the backend of one workflow ship halves of the *same* product
 * (same API paths, same launch command), not three paraphrases of one placeholder.
 */

const REQUIREMENT = '前端Web SPA 后端用python，后端用来记录每次排名和得分';
const PRODUCT = '开发一个俄罗斯方块程序';
const wrapped = (step: string): string => `Complete step "${step}" of workflow "${PRODUCT}": ${REQUIREMENT}`;

interface DeliveredFile {
  readonly path: string;
  readonly language: string;
  readonly content: string;
}

function filesOf(data: Readonly<Record<string, unknown>>): readonly DeliveredFile[] {
  const files = data['files'];
  expect(Array.isArray(files), 'every production delivery lists its files').toBe(true);
  return files as readonly DeliveredFile[];
}

describe('the step brief', () => {
  it('reads the product back out of the goal the workflow engine wrote', () => {
    expect(readStepBrief(wrapped('Backend'), 'Backend')).toEqual({
      stepName: 'Backend',
      productName: PRODUCT,
      requirement: REQUIREMENT,
    });
  });

  it('treats a goal with no wrapper as the product itself', () => {
    expect(readStepBrief('  把结算页做出来  ', 'Implementation')).toEqual({
      stepName: 'Implementation',
      productName: '把结算页做出来',
      requirement: '把结算页做出来',
    });
  });

  it('keeps the step name when the wrapper has an empty one', () => {
    expect(readStepBrief(`Complete step "" of workflow "${PRODUCT}": ${REQUIREMENT}`, 'Frontend').stepName).toBe(
      'Frontend',
    );
  });
});

describe('the product a step belongs to', () => {
  it('reads the plan, the game and the backend language from the requirement', () => {
    const spec = productSpec(wrapped('Backend'), 'Backend');
    expect(spec.capabilities).toEqual(['implementation', 'frontend', 'backend']);
    expect(spec.game).toBe('tetris');
    expect(spec.language).toBe('python');
    expect(spec.needsBackend).toBe(true);
    expect(spec.split).toBe(true);
  });

  it('reads a node backend out of a requirement that names one', () => {
    const spec = productSpec('Complete step "Backend" of workflow "api": 后端用 Node.js 写，接口记录得分', 'Backend');
    expect(spec.language).toBe('node');
    expect(spec.needsBackend).toBe(true);
  });

  it('defaults to python when the requirement names no language', () => {
    expect(backendLanguage('后端记录每次得分')).toBe('python');
  });

  it('does not match a two-letter hint inside a longer word', () => {
    expect(backendLanguage('typescript service')).toBe('node');
  });

  it('marks a product that nobody splits as unsplit', () => {
    expect(productSpec('开发一个贪吃蛇程序', 'Implementation').split).toBe(false);
  });

  it('still shapes an unlabelled delivery from the executor seat tags', () => {
    expect(deliveryShape(['implementation', 'frontend', 'backend'])).toBe('code');
    expect(deliveryShape(['testing'])).toBe('test');
    expect(deliveryShape(['technical_design'])).toBe('document');
    expect(deliveryShape([])).toBe('report');
  });
});

describe('the backend step', () => {
  const delivery = capabilityDelivery({ capability: 'backend', goal: wrapped('Backend'), title: 'Backend' });

  it('ships a runnable service, not the frontend page', () => {
    expect(delivery).not.toBeNull();
    if (delivery === null) return;
    expect(delivery.artifacts).toEqual(['server/app.py', 'server/README.md']);
    const content = String(delivery.data['content']);
    // Standard library only: the service runs the moment the owner runs it.
    expect(content).toContain('ThreadingHTTPServer');
    expect(content).toContain('sqlite3');
    expect(content).toContain('PRAGMA journal_mode=WAL');
    // The requirement's own words are the service's brief.
    expect(content).toContain('每次排名和得分');
    // It records plays and ranks them — the point of the step.
    expect(content).toContain('/api/scores');
    expect(content).toContain('INSERT INTO plays');
    expect(content).toContain('ORDER BY p.score DESC');
    expect(delivery.data['stack']).toEqual(['Python 3', 'sqlite3', 'http.server']);
  });

  it('hands over every file with its bytes', () => {
    if (delivery === null) return;
    const files = filesOf(delivery.data);
    expect(files.map((entry) => entry.path)).toEqual([...delivery.artifacts]);
    for (const entry of files) {
      expect(entry.content.length).toBeGreaterThan(0);
      expect(entry.language).not.toBe('');
    }
    expect(files[1]?.content).toContain('/api/scores');
  });
});

describe('the frontend step', () => {
  const delivery = capabilityDelivery({ capability: 'frontend', goal: wrapped('Frontend'), title: 'Frontend' });

  it('ships a playable client wired to the delivered service', () => {
    expect(delivery).not.toBeNull();
    if (delivery === null) return;
    expect(delivery.artifacts).toEqual(['client/index.html', 'client/README.md']);
    const content = String(delivery.data['content']);
    expect(content).toContain('<canvas id="board"');
    expect(content).toContain('requestAnimationFrame');
    // The client half of the same product: it posts plays and renders the shared board.
    expect(content).toContain('/api/scores');
    expect(content).toContain('window.maoehScore');
    expect(content).toContain('Leaderboard');
    expect(delivery.data['stack']).toEqual(['HTML5', 'JavaScript', 'Python 3 HTTP API']);
  });

  it('does not wire a leaderboard into a product that has no backend', () => {
    const standalone = capabilityDelivery({
      capability: 'frontend',
      goal: 'Complete step "Frontend" of workflow "贪吃蛇": 做一个 Web 端的贪吃蛇小游戏',
      title: 'Frontend',
    });
    expect(standalone).not.toBeNull();
    if (standalone === null) return;
    expect(String(standalone.data['content'])).toContain('<canvas id="board"');
    // No leaderboard UI and no service call: the game only *reports* a play when something defined
    // `window.maoehScore`, and nothing on a service-less page does.
    expect(String(standalone.data['content'])).not.toContain('/api/scores');
    expect(String(standalone.data['content'])).not.toContain('id="board-status"');
  });
});

describe('the implementation step', () => {
  it('owns the wiring when the product is split into parts', () => {
    const delivery = capabilityDelivery({
      capability: 'implementation',
      goal: wrapped('Implementation'),
      title: 'Implementation',
    });
    expect(delivery).not.toBeNull();
    if (delivery === null) return;
    expect(delivery.artifacts).toEqual(['run.py', 'README.md']);
    const launcher = String(delivery.data['content']);
    expect(launcher).toContain('app.py');
    expect(launcher).toContain('server.mjs');
    expect(launcher).toContain('webbrowser');
    const readme = filesOf(delivery.data)[1];
    expect(readme?.content).toContain('client/index.html');
    expect(readme?.content).toContain('server/app.py');
    expect(readme?.content).toContain('python run.py');
  });

  it('owns the whole product when nobody else builds one', () => {
    const delivery = capabilityDelivery({
      capability: 'implementation',
      goal: '开发一个贪吃蛇程序',
      title: 'Implementation',
    });
    expect(delivery).not.toBeNull();
    if (delivery === null) return;
    expect(delivery.artifacts).toEqual(['implementation/index.html', 'implementation/README.md']);
    expect(String(delivery.data['content'])).toContain('<canvas id="board"');
  });
});

describe('the other capability steps', () => {
  it('answers a design or requirement step with a document carrying its bytes', () => {
    const delivery = capabilityDelivery({
      capability: 'technical_design',
      goal: 'Complete step "Technical Design" of workflow "结算页": 设计结算页',
      title: 'Technical Design',
    });
    expect(delivery).not.toBeNull();
    if (delivery === null) return;
    expect(delivery.artifacts).toEqual(['technical-design.md']);
    expect(filesOf(delivery.data)[0]?.content).toContain('# Technical Design');
  });

  it('answers a testing step with a test report carrying its bytes', () => {
    const delivery = capabilityDelivery({
      capability: 'testing',
      goal: 'Complete step "Testing" of workflow "结算页": 设计并测试结算页',
      title: 'Testing',
    });
    expect(delivery).not.toBeNull();
    if (delivery === null) return;
    expect(delivery.artifacts).toEqual(['testing/test-report.md']);
    expect(delivery.data['passed']).toBe(true);
  });

  it('answers a capability it does not know with null, so the seat tags decide', () => {
    expect(capabilityDelivery({ capability: 'finance', goal: 'x', title: 'X' })).toBeNull();
    expect(capabilityDelivery({ capability: '   ', goal: 'x', title: 'X' })).toBeNull();
  });
});
