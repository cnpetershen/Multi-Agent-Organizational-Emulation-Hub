import { useState } from 'react';
import { parseRows, readNumber, type Row } from '../api';
import type { ConsoleControl } from '../control';
import { Empty, Panel, Table, eventDetail } from '../components';
import { useJson } from '../hooks';
import { useI18n } from '../i18n';

function preview(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const clean = text.replace(/\s+/g, ' ');
  return clean.length > 160 ? `${clean.slice(0, 160)}…` : clean;
}

export function EventsPage({ control }: { control: ConsoleControl }) {
  const { t } = useI18n();
  /**
   * The log keeps everything; this feed holds work that was removed back by default. The
   * toggle is the escape hatch — reading the full history is a query, never an edit.
   */
  const [showDeleted, setShowDeleted] = useState(false);
  const events = useJson(
    showDeleted ? '/api/events?limit=80&includeDeleted=1' : '/api/events?limit=80',
    parseRows,
    control.refreshToken,
  );
  const rows: readonly Row[] = (events.data ?? []).map((event) => ({
    ...event,
    seq: String(readNumber(event['seq'])),
    sim: `t${String(readNumber(event['occurredAtSim']))}`,
    payload: preview(event['payload']),
    detail: eventDetail(event),
  }));

  return (
    <div className="stack">
      <Panel
        title={t('events.panel')}
        actions={
          <>
            <span className="muted">{t('events.count', { count: rows.length })}</span>
            <button
              type="button"
              className="link"
              aria-pressed={showDeleted}
              onClick={() => setShowDeleted((value) => !value)}
            >
              {showDeleted ? t('events.hideDeleted') : t('events.showDeleted')}
            </button>
          </>
        }
      >
        {rows.length === 0 ? (
          <Empty
            title={events.status === 'failed' ? t('events.unavailable') : t('events.empty')}
            hint={events.error ?? t('events.emptyHint')}
          />
        ) : (
          <Table
            rows={rows}
            columns={['seq', 'type', 'actorId', 'subjectId', 'sim', 'payload']}
            labels={{ seq: t('events.seq'), actorId: t('events.actor'), subjectId: t('events.subject'), sim: t('events.simTime'), payload: t('events.payload') }}
            empty={t('events.tableEmpty')}
          />
        )}
      </Panel>
    </div>
  );
}
