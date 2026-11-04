import { describe, expect, it } from 'vitest';
import { detectGame, gamePage } from '../../../apps/api/src/game-deliverables';

/**
 * A game mandate must ship a *playable* artifact, not a page that only prints the step's name.
 * These assertions pin the shape a browser needs to run the delivery: a self-contained HTML
 * document, a `<canvas>` board, and the game loop/logic that makes it an actual game.
 */
describe('game deliverables', () => {
  it('recognizes the games a mandate can name, in English and Chinese', () => {
    expect(detectGame('开发一个俄罗斯方块程序')).toBe('tetris');
    expect(detectGame('写一个 Web 端的 Tetris')).toBe('tetris');
    expect(detectGame('做一个贪吃蛇小游戏')).toBe('snake');
    expect(detectGame('build a Snake game')).toBe('snake');
    expect(detectGame('重构用户登录模块')).toBeNull();
  });

  it('ships a runnable Tetris page for a tetris mandate', () => {
    const html = gamePage('tetris', 'Implementation', '开发一个俄罗斯方块程序');
    expect(html).toContain('<!doctype html');
    expect(html).toContain('<canvas id="board"');
    // The engine, not a placeholder: tetromino shapes, line clearing and the drop loop.
    expect(html).toContain('var SHAPES');
    expect(html).toContain('function clearLines');
    expect(html).toContain('function hardDrop');
    expect(html).toContain('requestAnimationFrame');
    // It reads as this mandate's work and is traceable on the delivery page.
    expect(html).toContain('开发一个俄罗斯方块程序');
  });

  it('ships a runnable Snake page for a snake mandate', () => {
    const html = gamePage('snake', 'Frontend', '做一个 Web 端的贪吃蛇小游戏');
    expect(html).toContain('<!doctype html');
    expect(html).toContain('<canvas id="board"');
    expect(html).toContain('function step');
    expect(html).toContain('requestAnimationFrame');
    expect(html).toContain('做一个 Web 端的贪吃蛇小游戏');
  });

  it('escapes the mandate text instead of injecting markup', () => {
    const html = gamePage('tetris', 'Implementation', '<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
