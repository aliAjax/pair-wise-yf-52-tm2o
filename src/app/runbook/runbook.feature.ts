import { createReducer, on } from '@ngrx/store';
import {
  rbBeginRevision,
  rbCancelRevision,
  rbCloseShow,
  rbConfirmRevision,
  rbFlushDevice,
  rbFreeze,
  rbQueueReceipt,
  rbResendReceipt,
  rbReset,
  rbSetDeviceOnline,
  rbUpdateRevision,
} from './runbook.actions';
import { initialRunbookState, runbookReducer } from './runbook.logic';
import { RunbookAction, RunbookState } from './runbook.models';

const STORAGE_KEY = 'yf52-runbook-state-v1';

export function nowStamp(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function loadInitial(): RunbookState {
  if (typeof localStorage === 'undefined') return initialRunbookState;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return initialRunbookState;
    const parsed = JSON.parse(saved) as RunbookState;
    // 简单结构校验，损坏缓存不致白屏
    if (!parsed || !parsed.devices || !parsed.log) return initialRunbookState;
    return parsed;
  } catch {
    return initialRunbookState;
  }
}

export const runbookFeatureReducer = createReducer(
  loadInitial(),
  on(rbFreeze, (state, { input }) => runbookReducer(state, { type: 'FREEZE', input, at: nowStamp() })),
  on(rbBeginRevision, (state, { note }) => runbookReducer(state, { type: 'BEGIN_REVISION', note, at: nowStamp() })),
  on(rbUpdateRevision, (state, { note, lines, cues }) =>
    runbookReducer(state, { type: 'UPDATE_REVISION', revision: { note, lines, cues } })),
  on(rbCancelRevision, (state) => runbookReducer(state, { type: 'CANCEL_REVISION' })),
  on(rbConfirmRevision, (state, { note, lines, cues, confirmedBy }) =>
    runbookReducer(state, { type: 'CONFIRM_REVISION', note, lines, cues, confirmedBy, at: nowStamp() })),
  on(rbQueueReceipt, (state, { input }) => runbookReducer(state, { type: 'QUEUE_RECEIPT', input, at: nowStamp() })),
  on(rbResendReceipt, (state, { deviceId, deviceSeq }) =>
    runbookReducer(state, { type: 'RESEND_RECEIPT', deviceId, deviceSeq, at: nowStamp() })),
  on(rbFlushDevice, (state, { deviceId }) => runbookReducer(state, { type: 'FLUSH_DEVICE', deviceId, at: nowStamp() })),
  on(rbSetDeviceOnline, (state, { deviceId, online }) =>
    runbookReducer(state, { type: 'SET_DEVICE_ONLINE', deviceId, online, at: nowStamp() })),
  on(rbCloseShow, (state) => runbookReducer(state, { type: 'CLOSE_SHOW', at: nowStamp() })),
  on(rbReset, () => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
    return initialRunbookState;
  }),
);

export function persistRunbook(state: RunbookState): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export type { RunbookAction };
