import { createReducer, on } from '@ngrx/store';
import { ScriptVersion } from './script.reducer';
import {
  activateRunning,
  applyOrderDraft,
  finishPerformance,
  freezeRunning,
  markCueExecuted,
  setRole,
  setRunningOnline,
  simulateDuplicate,
  uploadNextBatch
} from './running.actions';

export type Department = 'lighting' | 'sound' | 'stage';
export type RunItemStatus = 'pending' | 'executed' | 'voided';
export type Role = 'stageManager' | 'stageCrew';

export interface RunningLine {
  id: string;
  seq: number;
  role: string;
  text: string;
  status: RunItemStatus;
}

export interface RunningCue {
  id: string;
  /** 执行顺序；作废项为 null，已执行项保留历史顺序 */
  seq: number | null;
  department: Department;
  scene: string;
  text: string;
  /** 灯光口令：仅舞台监督可见，场务不可见 */
  command: string;
  status: RunItemStatus;
  /** 执行时所属的顺序版本，用于识别迟到回执 */
  orderRevision: number;
  executedAt: number | null;
  executedBy: string | null;
}

export interface Receipt {
  /** 回执唯一标识，重复回执按此去重 */
  id: string;
  runningId: string;
  /** 设备序号：合并时按设备序号对齐 */
  deviceSerial: string;
  department: Department;
  targetType: 'cue' | 'line';
  targetId: string;
  seq: number | null;
  /** 执行时的顺序版本；小于当前顺序版本即为迟到回执 */
  orderRevision: number;
  timestamp: number;
  synced: boolean;
  /** 迟到回执：到达时顺序已变更，只入历史，不盖到新顺序上 */
  late: boolean;
}

export interface RunningVersion {
  id: string;
  sourceVersionId: string;
  label: string;
  frozenAt: number;
  /** 顺序版本号：每次舞台监督确认顺序变化后 +1 */
  orderRevision: number;
  status: 'running' | 'finished';
  lines: RunningLine[];
  cues: RunningCue[];
}

export interface RunningState {
  versions: RunningVersion[];
  activeRunningId: string | null;
  /** 已合并回执（历史档案，演出结束后仍可按版本查询） */
  receipts: Receipt[];
  /** 离线待上传队列 */
  pendingQueue: Receipt[];
  /** 断点续传位置 */
  uploadCursor: number;
  /** 被去重忽略的重复回执计数 */
  duplicatesIgnored: number;
  role: Role;
  /** 本机设备序号 */
  deviceSerial: string;
  online: boolean;
}

const UPLOAD_BATCH = 2;

function inferDepartment(text: string): Department {
  if (/灯|光|追光|收光|切光|暗|亮/.test(text)) return 'lighting';
  if (/雨|声|音乐|麦|音效|铃/.test(text)) return 'sound';
  return 'stage';
}

function commandFor(department: Department, seq: number): string {
  return department === 'lighting' ? `LX-${String(seq).padStart(2, '0')}` : '';
}

/** 把剧本版本冻结成演出运行版：台词与舞台提示各自带上执行顺序。 */
export function createRunningVersion(script: ScriptVersion, now: number): RunningVersion {
  return {
    id: `run-${script.id}-${now}`,
    sourceVersionId: script.id,
    label: `演出运行版 · ${script.label}`,
    frozenAt: now,
    orderRevision: 1,
    status: 'running',
    lines: script.lines.map((line, index) => ({
      id: line.id,
      seq: index + 1,
      role: line.role,
      text: line.text,
      status: 'pending' as RunItemStatus
    })),
    cues: script.cues.map((cue, index) => {
      const seq = index + 1;
      const department = inferDepartment(`${cue.scene} ${cue.text}`);
      return {
        id: cue.id,
        seq,
        department,
        scene: cue.scene,
        text: cue.text,
        command: commandFor(department, seq),
        status: 'pending' as RunItemStatus,
        orderRevision: 1,
        executedAt: null,
        executedBy: null
      };
    })
  };
}

/**
 * 合并单条回执：
 * - 按回执 id 去重，重复回执只算一次；
 * - 顺序版本一致才盖到当前顺序上；顺序已变更（或演出已结束）的回执标记为迟到，只入历史。
 */
function acceptReceipt(state: RunningState, receipt: Receipt): RunningState {
  if (state.receipts.some((item) => item.id === receipt.id)) {
    return state;
  }
  const target = state.versions.find((version) => version.id === receipt.runningId);
  let versions = state.versions;
  let late = false;
  if (target && target.status === 'running' && receipt.orderRevision === target.orderRevision) {
    versions = state.versions.map((version) => {
      if (version.id !== receipt.runningId) return version;
      return {
        ...version,
        cues: version.cues.map((cue) =>
          cue.id === receipt.targetId && cue.status === 'pending'
            ? {
                ...cue,
                status: 'executed' as RunItemStatus,
                executedAt: receipt.timestamp,
                executedBy: receipt.deviceSerial,
                orderRevision: receipt.orderRevision
              }
            : cue
        )
      };
    });
  } else {
    // 迟到回执：顺序已变更或演出已结束，不能盖到新顺序上
    late = true;
  }
  return {
    ...state,
    versions,
    receipts: [...state.receipts, { ...receipt, synced: true, late }]
  };
}

function seedState(): RunningState {
  const now = Date.now();
  const runV12: RunningVersion = {
    id: 'run-v12',
    sourceVersionId: 'v12',
    label: '演出运行版 · 排练稿 v12',
    frozenAt: now - 86_400_000,
    orderRevision: 2,
    status: 'running',
    lines: [
      { id: 'l1', seq: 1, role: '周岚', text: '你每次都说等明天，可舞台不会等我们。', status: 'pending' },
      { id: 'l2', seq: 2, role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'pending' }
    ],
    cues: [
      {
        id: 'c1',
        seq: 1,
        department: 'lighting',
        scene: '第三场',
        text: '侧灯收至30%，雨声渐入',
        command: 'LX-01',
        status: 'executed',
        orderRevision: 1,
        executedAt: now - 600_000,
        executedBy: 'LX-A102'
      },
      {
        id: 'c2',
        seq: 2,
        department: 'stage',
        scene: '第三场',
        text: '周野坐到舞台左前区，保留两拍静默',
        command: '',
        status: 'pending',
        orderRevision: 2,
        executedAt: null,
        executedBy: null
      }
    ]
  };
  const runV11: RunningVersion = {
    id: 'run-v11',
    sourceVersionId: 'v11',
    label: '演出运行版 · 首演 v11',
    frozenAt: now - 2 * 86_400_000,
    orderRevision: 1,
    status: 'finished',
    lines: [
      { id: 'l1', seq: 1, role: '周岚', text: '你每次都说等明天，可舞台不会等我们。', status: 'pending' },
      { id: 'l2', seq: 2, role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'executed' }
    ],
    cues: [
      {
        id: 'c1',
        seq: 1,
        department: 'lighting',
        scene: '第三场',
        text: '侧灯收至30%，雨声渐入',
        command: 'LX-01',
        status: 'executed',
        orderRevision: 1,
        executedAt: now - 2 * 86_400_000 + 120_000,
        executedBy: 'LX-A102'
      },
      {
        id: 'c2',
        seq: 2,
        department: 'stage',
        scene: '第三场',
        text: '周野坐到舞台左前区，保留两拍静默',
        command: '',
        status: 'executed',
        orderRevision: 1,
        executedAt: now - 2 * 86_400_000 + 240_000,
        executedBy: 'STG-C315'
      },
      {
        id: 'c3',
        seq: null,
        department: 'sound',
        scene: '第三场',
        text: '雨声渐入（导演临时删除）',
        command: '',
        status: 'voided',
        orderRevision: 1,
        executedAt: null,
        executedBy: null
      }
    ]
  };
  const receipts: Receipt[] = [
    {
      id: 'rcpt-seed-1',
      runningId: 'run-v12',
      deviceSerial: 'LX-A102',
      department: 'lighting',
      targetType: 'cue',
      targetId: 'c1',
      seq: 1,
      orderRevision: 1,
      timestamp: now - 600_000,
      synced: true,
      late: false
    },
    {
      // 迟到回执：音效台在旧顺序下执行，上传时顺序已变，只入历史
      id: 'rcpt-seed-2',
      runningId: 'run-v12',
      deviceSerial: 'SND-B207',
      department: 'sound',
      targetType: 'cue',
      targetId: 'c2',
      seq: 2,
      orderRevision: 1,
      timestamp: now - 300_000,
      synced: true,
      late: true
    },
    {
      id: 'rcpt-seed-3',
      runningId: 'run-v11',
      deviceSerial: 'LX-A102',
      department: 'lighting',
      targetType: 'cue',
      targetId: 'c1',
      seq: 1,
      orderRevision: 1,
      timestamp: now - 2 * 86_400_000 + 120_000,
      synced: true,
      late: false
    },
    {
      id: 'rcpt-seed-4',
      runningId: 'run-v11',
      deviceSerial: 'STG-C315',
      department: 'stage',
      targetType: 'cue',
      targetId: 'c2',
      seq: 2,
      orderRevision: 1,
      timestamp: now - 2 * 86_400_000 + 240_000,
      synced: true,
      late: false
    }
  ];
  return {
    versions: [runV12, runV11],
    activeRunningId: 'run-v12',
    receipts,
    pendingQueue: [],
    uploadCursor: 0,
    duplicatesIgnored: 0,
    role: 'stageManager',
    deviceSerial: `STG-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    online: true
  };
}

function getInitialState(): RunningState {
  const seed = seedState();
  if (typeof localStorage === 'undefined') return seed;
  const saved = localStorage.getItem('yf52-running-state');
  if (!saved) return seed;
  try {
    return { ...seed, ...(JSON.parse(saved) as Partial<RunningState>) };
  } catch {
    return seed;
  }
}

export const runningReducer = createReducer(
  getInitialState(),
  on(freezeRunning, (state, { version }) => ({
    ...state,
    versions: [...state.versions, version],
    activeRunningId: version.id
  })),
  on(activateRunning, (state, { id }) => ({ ...state, activeRunningId: id })),
  on(applyOrderDraft, (state, { runningId, lines: draftLines, cues: draftCues }) => ({
    ...state,
    versions: state.versions.map((version) => {
      if (version.id !== runningId) return version;
      // 未执行项作废重算：按草稿顺序重排执行顺序；已执行项保留原顺序与状态
      let lineSeq = 0;
      const lines = draftLines.map((line) => {
        if (line.status === 'executed') return line;
        if (line.status === 'voided') return { ...line, seq: null };
        return { ...line, seq: ++lineSeq, status: 'pending' as RunItemStatus };
      });
      let cueSeq = 0;
      const cues = draftCues.map((cue) => {
        if (cue.status === 'executed') return cue;
        if (cue.status === 'voided') return { ...cue, seq: null };
        return {
          ...cue,
          seq: ++cueSeq,
          status: 'pending' as RunItemStatus,
          orderRevision: version.orderRevision + 1
        };
      });
      return { ...version, lines, cues, orderRevision: version.orderRevision + 1 };
    })
  })),
  on(markCueExecuted, (state, { runningId, cueId }) => {
    const version = state.versions.find((item) => item.id === runningId);
    if (!version || version.status !== 'running') return state;
    const cue = version.cues.find((item) => item.id === cueId);
    if (!cue || cue.status !== 'pending') return state;
    const now = Date.now();
    const receipt: Receipt = {
      id: `rcpt-${state.deviceSerial}-${cueId}-${now}`,
      runningId,
      deviceSerial: state.deviceSerial,
      department: cue.department,
      targetType: 'cue',
      targetId: cueId,
      seq: cue.seq,
      orderRevision: version.orderRevision,
      timestamp: now,
      synced: state.online,
      late: false
    };
    // 在线立即合并；离线进入待上传队列，恢复网络后从断点继续
    return state.online ? acceptReceipt(state, receipt) : { ...state, pendingQueue: [...state.pendingQueue, receipt] };
  }),
  on(setRole, (state, { role }) => ({ ...state, role })),
  on(setRunningOnline, (state, { online }) => ({ ...state, online })),
  on(uploadNextBatch, (state) => {
    if (!state.online) return state;
    const chunk = state.pendingQueue.slice(state.uploadCursor, state.uploadCursor + UPLOAD_BATCH);
    if (chunk.length === 0) return state;
    let next = state;
    for (const receipt of chunk) {
      next = acceptReceipt(next, receipt);
    }
    const cursor = state.uploadCursor + chunk.length;
    // 传到队尾即清空队列；否则断点停在 cursor，下次接着传
    return cursor >= state.pendingQueue.length
      ? { ...next, pendingQueue: [], uploadCursor: 0 }
      : { ...next, uploadCursor: cursor };
  }),
  on(finishPerformance, (state, { runningId }) => ({
    ...state,
    versions: state.versions.map((version) =>
      version.id === runningId ? { ...version, status: 'finished' as const } : version
    )
  })),
  on(simulateDuplicate, (state) => {
    const first = state.receipts[0];
    if (!first) return state;
    const before = state.receipts.length;
    const next = acceptReceipt(state, { ...first });
    return { ...next, duplicatesIgnored: next.receipts.length === before ? state.duplicatesIgnored + 1 : state.duplicatesIgnored };
  })
);
