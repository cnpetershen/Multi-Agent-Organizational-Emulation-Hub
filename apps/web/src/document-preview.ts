import type { TaskRecord } from './api';
import { isPlayableGame as detectsPlayableGame } from './playable';
import { isSpatialDelivery } from './spatial';
import { deliverableKind, deliveredFiles, type DeliveredFile } from './results';

/**
 * The document sheet behind "my AI company wrote this".
 *
 * `results.ts` already classifies a delivery as code/document/report and renders the labelled
 * facts. What it could not do is *show the document*: the old panel printed `result.data.content`
 * as escaped prose, so headings, lists, tables and code blocks were lost. This module picks the
 * right body out of a delivery (a real `.md` file if one was attached, else the single-file
 * `content` contract) and says how it should be drawn.
 *
 * Pure, like every presentation model in this app: a unit test can pin "which file becomes the
 * sheet" without a DOM.
 */

export type DocumentPreviewKind = 'markdown' | 'html' | 'text';

export interface DocumentPreviewModel {
  readonly kind: DocumentPreviewKind;
  readonly title: string;
  /** The body to render, already trimmed and bounded. */
  readonly content: string;
  /** The delivered path the body came from, or `null` for the single-file `content` contract. */
  readonly sourcePath: string | null;
  /** Every file the delivery carries, so the sheet can offer "source" and downloads. */
  readonly files: readonly DeliveredFile[];
}

/** A document larger than this is a data dump, not a page; the sheet stays responsive. */
const MAX_PREVIEW_CHARS = 240_000;

function extensionOf(path: string): string {
  const name = path.trim().toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

function isMarkdownPath(path: string): boolean {
  const extension = extensionOf(path);
  return extension === '.md' || extension === '.markdown';
}

function isHtmlPath(path: string): boolean {
  const extension = extensionOf(path);
  return extension === '.html' || extension === '.htm';
}

function looksLikeHtml(content: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(content);
}

/** The first ATX heading of a Markdown document, or `''`. */
export function markdownTitle(content: string): string {
  const match = /^\s*#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim().replace(/\s+/g, ' ') ?? '';
}

function titleOf(content: string, model: string, task: TaskRecord): string {
  const heading = markdownTitle(content);
  if (heading !== '') return heading;
  if (model.trim() !== '') return model.trim();
  return task.title;
}

function bounded(content: string): string {
  return content.length > MAX_PREVIEW_CHARS ? `${content.slice(0, MAX_PREVIEW_CHARS)}\n\n…` : content;
}

/**
 * Pick the document body of one delivery.
 *
 * A real `.md` file wins because it is the artifact the owner can also download; the single-file
 * `content` contract is the fallback for a model that answered with one field. An HTML document
 * is kept as HTML (the sheet renders it in a scripts-disabled frame) but only for a *document*
 * delivery — a runnable page is the preview panel's job, not this sheet's.
 */
export function documentPreviewOf(task: TaskRecord): DocumentPreviewModel | null {
  const result = task.result;
  if (result === null) return null;
  const files = deliveredFiles(task);
  // A playable game can also carry a README/design note. It is still a game: the sheet must not
  // claim the delivery is a document just because the first file happens to be Markdown.
  if (detectsPlayableGame(task, files)) return null;
  if (isSpatialDelivery(files)) return null;
  const kind = deliverableKind(result, task);
  const declaredName = typeof result.data['name'] === 'string' ? result.data['name'].trim() : '';

  const markdownFiles = files
    .filter((file) => isMarkdownPath(file.path) && file.content.trim() !== '')
    .sort((left, right) => right.content.length - left.content.length);
  const chosenMarkdown = markdownFiles[0];
  if (chosenMarkdown !== undefined) {
    return {
      kind: 'markdown',
      title: titleOf(chosenMarkdown.content, declaredName, task),
      content: bounded(chosenMarkdown.content),
      sourcePath: chosenMarkdown.path,
      files,
    };
  }

  if (kind === 'document') {
    const htmlFiles = files
      .filter((file) => isHtmlPath(file.path) && file.content.trim() !== '')
      .sort((left, right) => right.content.length - left.content.length);
    const chosenHtml = htmlFiles[0];
    if (chosenHtml !== undefined) {
      return {
        kind: 'html',
        title: titleOf('', declaredName, task),
        content: bounded(chosenHtml.content),
        sourcePath: chosenHtml.path,
        files,
      };
    }
  }

  const declared = result.data['content'];
  const body = typeof declared === 'string' ? declared.trim() : '';
  if (body !== '') {
    const html = looksLikeHtml(body);
    if (!html || kind === 'document') {
      return {
        kind: html ? 'html' : 'markdown',
        title: titleOf(html ? '' : body, declaredName, task),
        content: bounded(body),
        sourcePath: null,
        files,
      };
    }
  }

  const textFiles = files
    .filter((file) => extensionOf(file.path) === '.txt' && file.content.trim() !== '')
    .sort((left, right) => right.content.length - left.content.length);
  const chosenText = textFiles[0];
  if (chosenText !== undefined && kind === 'document') {
    return {
      kind: 'text',
      title: titleOf('', declaredName, task),
      content: bounded(chosenText.content),
      sourcePath: chosenText.path,
      files,
    };
  }

  return null;
}

/**
 * Is this delivery a playable game?
 *
 * Used only for the badge and the Network delivery rail — the real check remains the preview
 * runtime, which actually boots the page. The heuristic requires a canvas *and* a game loop or
 * keyboard handler, so a dashboard with a chart canvas is not called a game.
 */
export function isPlayableGame(task: TaskRecord): boolean {
  return detectsPlayableGame(task, deliveredFiles(task));
}
