import { createAction, props } from '@ngrx/store';
import { Department, Role, RunningVersion } from './running.reducer';

/** 冻结：把当前剧本版本冻结成演出运行版（台词与提示各自带执行顺序）。 */
export const freezeRunning = createAction('[Running] Freeze', props<{ version: RunningVersion }>());

/** 切换当前查看的演出运行版。 */
export const activateRunning = createAction('[Running] Activate Running', props<{ id: string }>());

/**
 * 舞台监督确认顺序变化：
 * 草稿中未执行的项作废重算（重排执行顺序），已执行的项保留原顺序。
 */
export const applyOrderDraft = createAction(
  '[Running] Apply Order Draft',
  props<{ runningId: string; lines: RunningVersion['lines']; cues: RunningVersion['cues'] }>()
);

/** 执行舞台提示（灯光/音效/场务回执），离线时进入待上传队列。 */
export const markCueExecuted = createAction('[Running] Mark Cue Executed', props<{ runningId: string; cueId: string }>());

/** 切换岗位：场务看不到灯光口令。 */
export const setRole = createAction('[Running] Set Role', props<{ role: Role }>());

/** 网络状态：恢复网络后待上传队列从断点继续。 */
export const setRunningOnline = createAction('[Running] Set Online', props<{ online: boolean }>());

/** 上传一批回执（断点续传：从 uploadCursor 开始）。 */
export const uploadNextBatch = createAction('[Running] Upload Next Batch');

/** 演出结束：之后回执只入历史，不再改动运行顺序。 */
export const finishPerformance = createAction('[Running] Finish Performance', props<{ runningId: string }>());

/** 模拟同一条回执重复上传，验证“重复回执只算一次”。 */
export const simulateDuplicate = createAction('[Running] Simulate Duplicate Receipt');
