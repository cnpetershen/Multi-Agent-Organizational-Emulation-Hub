import { describe, expect, it } from 'vitest';
import type { ApiRuntime } from '../../apps/api/src/api-adapter';
import { handleApiRequest } from '../../apps/api/src/api-adapter';
import type { ContentStudioResult } from '../../apps/api/src/content-studio';
import { ContentStudioError } from '../../apps/api/src/content-studio';
import { contentStudioPage } from '../../apps/api/src/content-studio-page';

/**
 * The two HTTP surfaces of the 一鱼多吃 workbench.
 *
 * The page is served by the API itself, so these tests are the same contract the browser depends
 * on: the workbench is reachable, the endpoint is the one the page calls, and a failure is a typed
 * status the page can render instead of a stack trace.
 */

const RESULT: ContentStudioResult = {
  provenance: 'live',
  provider: 'deepseek',
  model: 'deepseek-flash',
  source: 'source material',
  calls: 2,
  assets: [
    { platform: 'xiaohongshu', name: '小红书', kind: '图文笔记', text: 'xiaohongshu copy' },
    { platform: 'wechat', name: '公众号', kind: '推文', text: 'wechat copy' },
  ],
};

function runtimeWith(content: ApiRuntime['content']): ApiRuntime {
  return { control: null as never, query: null as never, ...(content === undefined ? {} : { content }) };
}

const get = (path: string): Request => new Request(`http://localhost${path}`);

const post = (path: string, body: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('一鱼多吃 workbench over HTTP', () => {
  it('serves a page whose own generation endpoint is the one this API exposes', async () => {
    const response = await handleApiRequest(get('/api/studio'), runtimeWith({ page: contentStudioPage, generate: async () => RESULT }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const page = await response.text();
    expect(page).toContain('/api/content/generate');
    expect(page).toContain('一鱼多吃');
    // The page must not ship platform copy of its own: an empty generation is allowed to look
    // empty. (This phrase was the template's fixed 小红书 text.)
    expect(page).not.toContain('3 个让你效率翻倍的小技巧');
  });

  it('generates through the port and returns the provenance with the assets', async () => {
    const response = await handleApiRequest(
      post('/api/content/generate', { source: 'source material', platforms: ['xiaohongshu', 'wechat'] }),
      runtimeWith({ page: contentStudioPage, generate: async () => RESULT }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESULT);
  });

  it('answers 400 for an invalid request and 502 for a provider failure', async () => {
    const invalid = await handleApiRequest(
      post('/api/content/generate', { source: '' }),
      runtimeWith({
        page: contentStudioPage,
        generate: async () => {
          throw new ContentStudioError('invalid', 'source must not be empty');
        },
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'invalid_content' });

    const failed = await handleApiRequest(
      post('/api/content/generate', { source: 'x' }),
      runtimeWith({
        page: contentStudioPage,
        generate: async () => {
          throw new ContentStudioError('provider', 'platform "douyin" generation failed: provider_error');
        },
      }),
    );
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: 'content_generation_failed' });
  });

  it('is honestly unavailable when the runtime has no content service', async () => {
    const page = await handleApiRequest(get('/api/studio'), runtimeWith(undefined));
    expect(page.status).toBe(503);
    expect(page.headers.get('content-type')).toContain('text/html');

    const generate = await handleApiRequest(
      post('/api/content/generate', { source: 'x' }),
      runtimeWith(undefined),
    );
    expect(generate.status).toBe(501);
  });
});
