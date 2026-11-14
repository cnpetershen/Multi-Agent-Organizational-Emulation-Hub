import { useEffect, useMemo, useState } from 'react';
import { requestJson, type TaskRecord } from '../api';
import { documentPreviewOf, type DocumentPreviewModel } from '../document-preview';

const KIND_KEYS: Readonly<Record<DocumentPreviewModel['kind'], MessageKey>> = {
  markdown: 'results.document.kind.markdown',
  html: 'results.document.kind.html',
  text: 'results.document.kind.text',
};
import { parseMarkdown, type InlineNode, type MarkdownBlock } from '../markdown';
import { useI18n, type MessageKey } from '../i18n';

/**
 * The delivered document, rendered as a document.
 *
 * The delivery page used to print `result.data.content` as escaped prose, which turned every
 * heading, list and table into a wall of `#` and `-`. This sheet renders the same bytes as the
 * artifact it is: a paper-like page for Markdown, a scripts-disabled frame for a delivered HTML
 * document, and a monospace page for plain text.
 *
 * Safety is structural, not sanitized-after-the-fact: Markdown becomes a block tree (never an
 * HTML string), links are scheme-checked, and an HTML document is framed with `sandbox=""` so it
 * cannot run scripts or reach the console's origin.
 */

function Inlines({ nodes }: { nodes: readonly InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case 'code':
            return <code key={index}>{node.text}</code>;
          case 'strong':
            return <strong key={index}>{node.text}</strong>;
          case 'em':
            return <em key={index}>{node.text}</em>;
          case 'link':
            return (
              <a key={index} href={node.href} target="_blank" rel="noreferrer noopener">
                {node.text}
              </a>
            );
          default:
            return <span key={index}>{node.text}</span>;
        }
      })}
    </>
  );
}

function MarkdownView({ blocks }: { blocks: readonly MarkdownBlock[] }) {
  return (
    <div className="doc-markdown">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = (`h${Math.min(6, Math.max(1, block.level))}`) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
            return <Tag key={index}><Inlines nodes={block.inlines} /></Tag>;
          }
          case 'paragraph':
            return <p key={index}><Inlines nodes={block.inlines} /></p>;
          case 'list': {
            const items = block.items.map((item, itemIndex) => (
              <li key={itemIndex}><Inlines nodes={item} /></li>
            ));
            return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
          }
          case 'code':
            return (
              <pre key={index} className="doc-code" data-language={block.language || undefined}>
                <code>{block.content}</code>
              </pre>
            );
          case 'quote':
            return <blockquote key={index}><Inlines nodes={block.inlines} /></blockquote>;
          case 'hr':
            return <hr key={index} />;
          case 'table':
            return (
              <div className="doc-table-wrap" key={index}>
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? undefined }}>{cell}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? undefined }}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

function Body({ model }: { model: DocumentPreviewModel }) {
  if (model.kind === 'markdown') return <MarkdownView blocks={parseMarkdown(model.content)} />;
  if (model.kind === 'html') {
    return (
      <iframe
        className="doc-html-frame"
        title="Delivered HTML document"
        sandbox=""
        srcDoc={model.content}
      />
    );
  }
  return <pre className="doc-plain">{model.content}</pre>;
}

export function DocumentPreview({
  task,
  fallback = '',
  compact = false,
}: {
  readonly task: TaskRecord;
  /** The prose the old panel would have shown, used when no document body can be found. */
  readonly fallback?: string;
  readonly compact?: boolean;
}) {
  const { t } = useI18n();
  const model = useMemo(() => documentPreviewOf(task), [task]);
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  /** Bilingual sheet: the original is always the source of truth; English is fetched on demand. */
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const [translated, setTranslated] = useState('');
  const [translating, setTranslating] = useState(false);
  const [translationError, setTranslationError] = useState('');

  useEffect(() => {
    setLanguage(/[\u4e00-\u9fff]/.test(model?.content ?? '') ? 'zh' : 'en');
    setTranslated('');
    setTranslationError('');
  }, [model?.content, model?.sourcePath]);

  const translate = async (target: 'en' | 'zh'): Promise<void> => {
    if (model === null || translating) return;
    if (translated !== '' && language === target) {
      setLanguage(target);
      return;
    }
    setTranslating(true);
    setTranslationError('');
    try {
      const payload = await requestJson('/api/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: model.content, target }),
      });
      const text = typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)['text']
        : null;
      if (typeof text !== 'string' || text.trim() === '') throw new Error(t('results.document.translationEmpty'));
      setTranslated(text);
      setLanguage(target);
    } catch (cause) {
      setTranslationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTranslating(false);
    }
  };

  if (model === null) {
    if (fallback.trim() === '') {
      return <p className="doc-empty muted">{t('results.document.empty')}</p>;
    }
    return <pre className="doc-plain">{fallback}</pre>;
  }

  const sourceLanguage = /[\u4e00-\u9fff]/.test(model.content) ? 'zh' : 'en';
  const shown: DocumentPreviewModel = language !== sourceLanguage && translated !== ''
    ? { ...model, content: translated }
    : model;

  return (
    <div className={`doc-sheet${compact ? ' compact' : ''}`} data-kind={model.kind}>
      {!compact && (
        <div className="doc-sheet-bar">
          <span className="doc-kind">{t(KIND_KEYS[model.kind])}</span>
          <span className="doc-source-path">{model.sourcePath ?? t('results.document.inline')}</span>
          {model.kind !== 'html' && (
            <div className="doc-lang" role="group" aria-label={t('results.document.language')}>
              <button
                type="button"
                className={language === 'zh' ? 'active' : ''}
                disabled={translating}
                onClick={() => { if (sourceLanguage === 'zh') setLanguage('zh'); else void translate('zh'); }}
              >
                {t('results.document.chinese')}
              </button>
              <button
                type="button"
                className={language === 'en' ? 'active' : ''}
                disabled={translating}
                onClick={() => { if (sourceLanguage === 'en') setLanguage('en'); else void translate('en'); }}
              >
                {translating ? t('results.document.translating') : t('results.document.english')}
              </button>
            </div>
          )}
          <div className="doc-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'preview'}
              className={mode === 'preview' ? 'active' : ''}
              onClick={() => setMode('preview')}
            >
              {t('results.document.previewTab')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'source'}
              className={mode === 'source' ? 'active' : ''}
              onClick={() => setMode('source')}
            >
              {t('results.document.sourceTab')}
            </button>
          </div>
        </div>
      )}
      <div className="doc-sheet-body">
        {mode === 'source' ? (
          <pre className="doc-plain source">{shown.content}</pre>
        ) : (
          <Body model={shown} />
        )}
      </div>
      {!compact && (
        <div className="doc-sheet-foot">
          <span>{t('results.document.rendered')}</span>
          {language !== sourceLanguage && <span>{t('results.document.machineTranslated')}</span>}
          {translationError !== '' && <span className="doc-translation-error">{translationError}</span>}
          {model.kind === 'html' && <span>{t('results.document.scriptsDisabled')}</span>}
        </div>
      )}
    </div>
  );
}
