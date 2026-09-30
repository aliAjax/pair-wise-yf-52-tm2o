import { createAction, props } from '@ngrx/store';
import {
  DeviceId,
  FreezeInput,
  ReceiptInput,
  RevisionCueDraft,
} from './runbook.models';

export const rbFreeze = createAction('[Runbook] Freeze', props<{ input: FreezeInput }>());
export const rbBeginRevision = createAction('[Runbook] Begin Revision', props<{ note: string }>());
export const rbUpdateRevision = createAction(
  '[Runbook] Update Revision',
  props<{ note: string; lines: Array<{ role: string; text: string }>; cues: RevisionCueDraft[] }>(),
);
export const rbCancelRevision = createAction('[Runbook] Cancel Revision');
export const rbConfirmRevision = createAction(
  '[Runbook] Confirm Revision',
  props<{ note: string; lines: Array<{ role: string; text: string }>; cues: RevisionCueDraft[]; confirmedBy: string }>(),
);
export const rbQueueReceipt = createAction(
  '[Runbook] Queue Receipt',
  props<{ input: Omit<ReceiptInput, 'deviceSeq' | 'producedAt'> }>(),
);
export const rbResendReceipt = createAction(
  '[Runbook] Resend Receipt',
  props<{ deviceId: DeviceId; deviceSeq: number }>(),
);
export const rbFlushDevice = createAction('[Runbook] Flush Device', props<{ deviceId: DeviceId }>());
export const rbSetDeviceOnline = createAction(
  '[Runbook] Set Device Online',
  props<{ deviceId: DeviceId; online: boolean }>(),
);
export const rbCloseShow = createAction('[Runbook] Close Show');
export const rbReset = createAction('[Runbook] Reset');
