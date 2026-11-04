import { parseRows, readNumber, readString, type Row } from '../api';
import type { ConsoleControl } from '../control';
import { Empty, Panel, Table, eventDetail, payloadOf } from '../components';
import { collaborationRequest, employeeLabel } from '../derive';
import { useJson } from '../hooks';
import { useI18n, type I18n } from '../i18n';

function communicationView(control: ConsoleControl, event: Row, i18n: I18n): Row {
  const payload = payloadOf(event);
  const { employees, positions } = control.snapshot;
  const senderId = readString(payload['senderId'], readString(event['actorId'], ''));
  const recipients = Array.isArray(payload['recipientIds'])
    ? (payload['recipientIds'] as readonly unknown[])
        .map((id) => employeeLabel(employees, positions, String(id)))
        .join(', ')
    : '';
  const members = Array.isArray(payload['memberIds'])
    ? (payload['memberIds'] as readonly unknown[]).length
    : 0;
  return {
    ...event,
    from: senderId === '' ? '—' : employeeLabel(employees, positions, senderId),
    to: recipients === '' ? (members === 0 ? '—' : i18n.t('communications.channelMembers', { count: members })) : recipients,
    subject: readString(payload['subject'], readString(payload['channelType'], i18n.t('communications.channelOpened'))),
    kind: readString(payload['messageType'], readString(payload['channelType'], '—')),
    body: readString(payload['body'], ''),
    sim: `t${String(readNumber(event['occurredAtSim']))}`,
  };
}

/**
 * A collaboration request as a row: who asked whom, about which task, and for what. The
 * payload is the event's own — the view only turns the two employee ids into labels.
 */
function collaborationView(control: ConsoleControl, event: Row): Row {
  const request = collaborationRequest(event);
  const { employees, positions } = control.snapshot;
  return {
    ...event,
    from: request === null ? '—' : employeeLabel(employees, positions, request.fromAgentId),
    to: request === null ? '—' : employeeLabel(employees, positions, request.toAgentId),
    task: request === null ? '' : request.taskId,
    purpose: request === null ? '' : request.purpose,
    sim: `t${String(readNumber(event['occurredAtSim']))}`,
  };
}

/**
 * Communication is an event stream, not a chat store: `Communication.MessageSent` and
 * `Communication.ChannelOpened` are replayed from the log the same way every other page
 * reads state, so what is shown is exactly what agents actually said.
 */
export function CommunicationsPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const communications = useJson('/api/communications?limit=80', parseRows, control.refreshToken);
  const rows = (communications.data ?? []).map((event) => communicationView(control, event, i18n));
  const messages = rows.filter((row) => readString(row['type'], '') === 'Communication.MessageSent');
  const collaborations = rows
    .filter((row) => readString(row['type'], '') === 'Communication.CollaborationRequested')
    .map((row) => collaborationView(control, row));

  return (
    <div className="stack">
      <Panel
        title={t('communications.messages.panel')}
        actions={<span className="muted">{t('communications.messages.count', { count: messages.length })}</span>}
      >
        {messages.length === 0 ? (
          <Empty
            title={t('communications.messages.empty')}
            hint={t('communications.messages.emptyHint')}
          />
        ) : (
          <Table
            rows={messages}
            columns={['sim', 'from', 'to', 'subject', 'body']}
            labels={{ sim: t('communications.messages.time'), from: t('communications.messages.from'), to: t('communications.messages.to'), subject: t('communications.messages.subject'), body: t('communications.messages.body') }}
            empty={t('communications.messages.tableEmpty')}
          />
        )}
      </Panel>

      <Panel title={t('communications.channels.panel')}>
        {rows.filter((row) => readString(row['type'], '') === 'Communication.ChannelOpened').length === 0 ? (
          <Empty title={t('communications.channels.empty')} hint={t('communications.channels.emptyHint')} />
        ) : (
          <Table
            rows={rows.filter((row) => readString(row['type'], '') === 'Communication.ChannelOpened')}
            columns={['sim', 'from', 'to', 'kind']}
            labels={{ sim: t('communications.messages.time'), from: t('communications.channels.openedBy'), to: t('communications.channels.members'), kind: t('communications.channels.type') }}
            empty={t('communications.channels.tableEmpty')}
          />
        )}
      </Panel>

      <Panel
        title={t('communications.collaboration.panel')}
        actions={<span className="muted">{t('communications.collaboration.count', { count: collaborations.length })}</span>}
      >
        {collaborations.length === 0 ? (
          <Empty title={t('communications.collaboration.empty')} hint={t('communications.collaboration.emptyHint')} />
        ) : (
          <Table
            rows={collaborations}
            columns={['sim', 'from', 'to', 'task', 'purpose']}
            labels={{
              sim: t('communications.messages.time'),
              from: t('communications.messages.from'),
              to: t('communications.messages.to'),
              task: t('communications.collaboration.task'),
              purpose: t('communications.collaboration.purpose'),
            }}
            empty={t('communications.collaboration.tableEmpty')}
          />
        )}
      </Panel>

      <Panel title={t('communications.events.panel')}>
        {rows.length === 0 ? (
          <Empty title={t('communications.events.empty')} hint={t('communications.events.emptyHint')} />
        ) : (
          rows.slice(0, 12).map((row) => (
            <div className="row" key={readString(row['eventId'], String(row['seq']))}>
              <b>{readString(row['type'])}</b>
              <span>{eventDetail(row)}</span>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}
