import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { sandboxPage } from '../../../apps/api/src/sandbox-page';

/**
 * F1 regression: the workbench is an HTML string with an inline script. A `\n` written in the
 * outer template literal becomes a real newline in the served JavaScript and kills the whole
 * page before `data-maoeh-ready` is set. The test compiles the exact script the API serves.
 */
function inlineScript(html: string): string {
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  if (start === -1 || end <= start) throw new Error('the page has no inline script');
  return html.slice(start + '<script>'.length, end);
}

describe('M2 F1 sandbox page inline script', () => {
  it('is valid JavaScript once the template is rendered', () => {
    const script = inlineScript(sandboxPage());
    expect(() => new Script(script, { filename: 'sandbox-page.js' })).not.toThrow();
  });

  it('builds line delimiters at runtime instead of embedding a real newline', () => {
    const script = inlineScript(sandboxPage());
    expect(script).toContain('var NL = String.fromCharCode(10);');
    expect(script).toContain('split(NL)');
    expect(script).not.toContain("split('\n')");
  });
});
