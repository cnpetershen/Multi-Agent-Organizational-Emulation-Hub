import { useEffect, useState } from 'react';
import { parseTaskRecord, requestJson, type TaskRecord } from './api';

/**
 * Fetch a set of task records for one package.
 *
 * The delivery page already has the anchor record. Sibling steps are separate
 * `GET /api/tasks/:id` payloads, and the package needs them all before it can decide which step
 * carries the game, the document or the 3D asset. `Promise.allSettled` keeps one broken sibling
 * from hiding the other deliveries; the package simply renders what arrived.
 */
export interface TaskRecordsState {
  readonly records: Readonly<Record<string, TaskRecord>>;
  readonly loading: boolean;
  readonly error: string | null;
}

export function useTaskRecords(ids: readonly string[], refreshToken: number): TaskRecordsState {
  const key = ids.join('|');
  const [state, setState] = useState<TaskRecordsState>({ records: {}, loading: ids.length > 0, error: null });

  useEffect(() => {
    if (ids.length === 0) {
      setState({ records: {}, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((current) => ({ records: current.records, loading: true, error: null }));
    void Promise.allSettled(
      ids.map(async (taskId) => {
        const payload = await requestJson(`/api/tasks/${encodeURIComponent(taskId)}`);
        return [taskId, parseTaskRecord(payload, `task ${taskId}`)] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      const records: Record<string, TaskRecord> = {};
      let failures = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') records[result.value[0]] = result.value[1];
        else failures += 1;
      }
      setState({
        records,
        loading: false,
        error: failures === ids.length ? 'the package could not be loaded' : failures > 0 ? 'part of the package could not be loaded' : null,
      });
    });
    return () => { cancelled = true; };
    // `key` is the stable identity of the id set; the array itself is rebuilt on every render.
  }, [key, refreshToken]);

  return state;
}
