import type { TaskRecord } from './api';

/**
 * Is this delivery a playable game rather than a document?
 *
 * This is deliberately its own module. `results.ts` needs the answer to classify the delivery,
 * `document-preview.ts` needs the answer to *refuse* to render a game as a document, and both
 * already depend on the file list. Keeping the heuristic here (and passing the files in) avoids
 * a `results ⇄ document-preview` import cycle.
 *
 * The heuristic is purposefully conservative but not title-only:
 * - a `playable: true` delivery with an HTML entry is a game;
 * - a title naming a known game catches an SVG board (tic-tac-toe) that has no `<canvas>`;
 * - otherwise an HTML page must show a canvas + loop, or an SVG + script + pointer/key handler.
 * A dashboard with a chart canvas, and a static HTML document, stay non-games.
 */

export interface PlayableFile {
  readonly path: string;
  readonly content: string;
}

const GAME_TITLE = /game|tetris|snake|tac[- ]?toe|chess|puzzle|platformer|shooter|棋|游戏|小游戏|井字|射击|贪吃蛇|俄罗斯方块/i;

function isHtml(path: string): boolean {
  return /\.(?:html?|xhtml)$/i.test(path.trim());
}

function hasPlayableData(task: Pick<TaskRecord, 'result'>): boolean {
  const data = task.result?.data ?? {};
  return data['playable'] === true || data['game'] === true;
}

export function isPlayableGame(
  task: Pick<TaskRecord, 'title' | 'result'>,
  files: readonly PlayableFile[],
): boolean {
  const pages = files.filter((file) => isHtml(file.path) && file.content.trim() !== '');
  if (pages.length === 0) return false;
  if (hasPlayableData(task)) return true;
  if (GAME_TITLE.test(task.title)) return true;
  return pages.some(
    (file) =>
      /<canvas[\s>]/i.test(file.content) &&
      /(requestAnimationFrame|addEventListener\s*\(\s*['"]key|onkeydown|keydown|setInterval\s*\()/i.test(file.content),
  ) || pages.some(
    (file) =>
      /<svg[\s>]/i.test(file.content) &&
      /<script[\s>]/i.test(file.content) &&
      /addEventListener\s*\(\s*['"](?:click|keydown|keyup)/i.test(file.content),
  );
}
