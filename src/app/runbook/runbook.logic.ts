/**
 * 演出运行版核心规则（纯函数 + 可序列化状态，无任何 DOM/Angular 依赖）。
 *
 * 关键规则：
 * 1. FREEZE：冻结出 v1，台词序号（L#）与舞台提示序号（Q#）各自独立、连续。
 * 2. CONFIRM_REVISION：舞台监督确认换序后产生新版本：
 *    - 旧版本中尚未执行的提示一律 VOID 作废；已执行（DONE）的保留在旧版本不动。
 *    - 新版本只承接“仍在使用”的血缘；沿用未执行血缘的新行回到 PENDING；
 *      导演新增的提示分配新血缘。
 * 3. 设备回执按“设备序号”对齐合并：
 *    - QUEUE_RECEIPT：设备本地分配单调 deviceSeq 并入 outbox（断网也照常计序）。
 *    - FLUSH_DEVICE：恢复后从断点 syncedSeq 之后按序上传；
 *      同一 deviceSeq 重复只算一次（DUP）；缺号（GAP）拒绝并保留队列；
 *      指向作废/旧版本提示的迟到回执记 LATE_STALE，绝不盖到新顺序上。
 */

import {
  CONSOLE_ROLES,
  CUE_KINDS,
  ConsoleRole,
  CueKind,
  DeviceId,
  DeviceState,
  FreezeInput,
  MergeOutcome,
  OrderRevision,
  OutboxItem,
  ReceiptInput,
  ReceiptRecord,
  RevisionCueDraft,
  RunCue,
  RunShow,
  RunVersion,
  RunbookAction,
  RunbookState,
  cueKindOfDevice,
} from './runbook.models';

const DEVICE_IDS: DeviceId[] = ['LIGHT-01', 'SOUND-01', 'STAGE-01'];

export function createInitialDevices(): Record<DeviceId, DeviceState> {
  const record = {} as Record<DeviceId, DeviceState>;
  for (const deviceId of DEVICE_IDS) {
    record[deviceId] = {
      deviceId,
      online: true,
      producedCounter: 0,
      outbox: [],
      syncedSeq: 0,
      receipts: [],
    };
  }
  return record;
}

export const initialRunbookState: RunbookState = {
  show: null,
  revision: null,
  devices: createInitialDevices(),
  log: [],
};

function pushLog(state: RunbookState, at: string, message: string): RunbookState {
  return { ...state, log: [...state.log, { at, message }] };
}

/* ---------------------------------- 冻结 ---------------------------------- */

export function freezeShow(input: FreezeInput, at: string): RunShow {
  let lineageCounter = 0;
  let cueIdCounter = 0;
  const lines = input.lines.map((line, index) => ({
    seq: index + 1,
    role: line.role,
    text: line.text,
  }));
  const cues: RunCue[] = input.cues.map((cue, index) => {
    lineageCounter += 1;
    cueIdCounter += 1;
    return {
      id: `cue-${cueIdCounter}`,
      lineageId: `L${lineageCounter}`,
      versionSeq: 1,
      seq: index + 1,
      kind: cue.kind,
      label: cue.label,
      detail: cue.detail,
      status: 'PENDING',
      executedAt: null,
      receiptDeviceSeq: null,
    };
  });
  const v1: RunVersion = {
    versionSeq: 1,
    createdAt: at,
    note: `冻结自 ${input.frozenFrom}`,
    confirmedBy: null,
    lines,
    cues,
  };
  return {
    title: input.title,
    frozenFrom: input.frozenFrom,
    frozenAt: at,
    activeVersionSeq: 1,
    versions: [v1],
    closed: false,
    closedAt: null,
    lineageCounter,
    cueIdCounter,
  };
}

/* --------------------------------- 换序确认 -------------------------------- */

export function activeVersion(show: RunShow): RunVersion {
  return show.versions.find((v) => v.versionSeq === show.activeVersionSeq) ?? show.versions[show.versions.length - 1];
}

/**
 * 以当前版本为底，生成换序编辑草稿。
 * 只带出“尚未执行”的提示血缘；已执行提示是历史，不可再编辑/重排。
 */
export function beginRevision(show: RunShow, note: string, at: string): OrderRevision {
  const current = activeVersion(show);
  return {
    note,
    openedAt: at,
    lines: current.lines.map((line) => ({ role: line.role, text: line.text })),
    cues: current.cues
      .filter((cue) => cue.status === 'PENDING')
      .map((cue) => ({ lineageId: Number(cue.lineageId.slice(1)), kind: cue.kind, label: cue.label, detail: cue.detail })),
  };
}

export interface ConfirmResult {
  show: RunShow;
  voided: RunCue[];
  carried: Array<{ lineageId: string; newCueId: string }>;
}

/**
 * 确认换序。返回新的 show：
 * - 当前版本里未执行但未被新顺序沿用的提示 -> VOID（作废重算）。
 * - 当前版本里已执行的提示原样保留在当前版本。
 * - 新版本重新编号；沿用血缘的新行回到 PENDING（旧执行结果不跟随）。
 */
export function confirmRevision(
  show: RunShow,
  note: string,
  linesDraft: Array<{ role: string; text: string }>,
  cuesDraft: RevisionCueDraft[],
  confirmedBy: string,
  at: string,
): ConfirmResult {
  const current = activeVersion(show);
  const keptLineageIds = new Set(
    cuesDraft.filter((draft) => draft.lineageId !== null).map((draft) => `L${draft.lineageId}`),
  );

  const voided: RunCue[] = [];
  const updatedCues = current.cues.map((cue) => {
    if (cue.status === 'PENDING' && !keptLineageIds.has(cue.lineageId)) {
      const dead = { ...cue, status: 'VOID' as const };
      voided.push(dead);
      return dead;
    }
    return cue;
  });

  let lineageCounter = show.lineageCounter;
  let cueIdCounter = show.cueIdCounter;
  const carried: Array<{ lineageId: string; newCueId: string }> = [];
  const newVersionSeq = current.versionSeq + 1;

  const newCues: RunCue[] = cuesDraft.map((draft, index) => {
    let lineageId: string;
    if (draft.lineageId === null) {
      lineageCounter += 1;
      lineageId = `L${lineageCounter}`;
    } else {
      lineageId = `L${draft.lineageId}`;
    }
    cueIdCounter += 1;
    const newCueId = `cue-${cueIdCounter}`;
    carried.push({ lineageId, newCueId });
    return {
      id: newCueId,
      lineageId,
      versionSeq: newVersionSeq,
      seq: index + 1,
      kind: draft.kind,
      label: draft.label,
      detail: draft.detail,
      status: 'PENDING',
      executedAt: null,
      receiptDeviceSeq: null,
    };
  });

  const newVersion: RunVersion = {
    versionSeq: newVersionSeq,
    createdAt: at,
    note,
    confirmedBy,
    lines: linesDraft.map((line, index) => ({ seq: index + 1, role: line.role, text: line.text })),
    cues: newCues,
  };

  const versions = show.versions.map((version) =>
    version.versionSeq === current.versionSeq ? { ...version, cues: updatedCues } : version,
  );
  versions.push(newVersion);

  return {
    show: { ...show, versions, activeVersionSeq: newVersionSeq, lineageCounter, cueIdCounter },
    voided,
    carried,
  };
}

/* -------------------------------- 回执合并 -------------------------------- */

/** 在整场演出的所有版本中定位提示行（跨版本） */
function findCueAcrossVersions(show: RunShow, cueId: string): { cue: RunCue; versionSeq: number } | null {
  for (const version of show.versions) {
    const cue = version.cues.find((item) => item.id === cueId);
    if (cue) return { cue, versionSeq: version.versionSeq };
  }
  return null;
}

/**
 * 合并单条已上传回执。纯函数：返回新的 show / device 状态与结果。
 */
export function mergeReceipt(
  show: RunShow,
  device: DeviceState,
  receipt: ReceiptInput,
  receivedAt: string,
): { show: RunShow; device: DeviceState; record: ReceiptRecord } {
  const baseRecord: ReceiptRecord = {
    ...receipt,
    receivedAt,
    outcome: 'REJECTED',
    appliedCueId: null,
    versionSeq: null,
  };

  /** 硬停止：不出队、不推进断点（演出结束）。 */
  const stall = (outcome: MergeOutcome, versionSeq: number | null = null) => ({
    show,
    device,
    record: { ...baseRecord, outcome, versionSeq },
  });

  /** 顺序正确：登记台账并推进断点（无论内容落锤、幂等还是迟到作废）。 */
  const accept = (outcome: MergeOutcome, versionSeq: number | null, appliedCueId: string | null = null) => {
    const record = { ...baseRecord, outcome, versionSeq, appliedCueId };
    return { show, device: commitReceipt(device, receipt, record), record };
  };

  if (show.closed) return stall('REJECTED');

  // 重复回执：同设备同序号只算一次（哪怕内容指向不同提示，也以首次为准）。
  const existing = device.receipts.find((item) => item.deviceSeq === receipt.deviceSeq);
  if (existing) {
    return {
      show,
      device,
      record: { ...baseRecord, outcome: 'DUP', versionSeq: existing.versionSeq, appliedCueId: existing.appliedCueId },
    };
  }

  // 按设备序号对齐：只接受 syncedSeq 的下一号，杜绝乱序/缺号把旧回执盖到新顺序。
  if (receipt.deviceSeq !== device.syncedSeq + 1) {
    return stall('GAP');
  }

  const located = findCueAcrossVersions(show, receipt.cueId);
  if (!located) return accept('UNKNOWN_CUE', null);

  // 设备类型必须与提示类别一致（灯光台不能落锤音效提示）。
  if (located.cue.kind !== cueKindOfDevice(receipt.deviceId)) {
    return accept('LATE_STALE', located.versionSeq);
  }

  // 迟到回执：目标行已作废或属于旧版本 —— 只登记，绝不触碰新版本。
  if (located.cue.status === 'VOID' || located.versionSeq !== show.activeVersionSeq) {
    return accept('LATE_STALE', located.versionSeq);
  }

  if (located.cue.status === 'DONE') {
    return accept('ALREADY_DONE', located.versionSeq, located.cue.id);
  }

  // 落锤：只可能打在“当前版本 + 同类别 + PENDING”的行上。
  let appliedCue: RunCue | null = null;
  const versions = show.versions.map((version) => {
    if (version.versionSeq !== located.versionSeq) return version;
    return {
      ...version,
      cues: version.cues.map((cue) => {
        if (cue.id !== located.cue.id) return cue;
        appliedCue = {
          ...cue,
          status: 'DONE' as const,
          executedAt: receivedAt,
          receiptDeviceSeq: receipt.deviceSeq,
        };
        return appliedCue;
      }),
    };
  });

  const record: ReceiptRecord = {
    ...baseRecord,
    outcome: 'APPLIED',
    appliedCueId: located.cue.id,
    versionSeq: located.versionSeq,
  };
  return { show: { ...show, versions }, device: commitReceipt(device, receipt, record), record };
}

/**
 * 顺序正确的回执（无论落锤、幂等还是迟到作废）都登记入设备台账并推进断点；
 * 这样后续设备序号才能继续合并。GAP / REJECTED 不推进、不出队。
 */
function commitReceipt(device: DeviceState, receipt: ReceiptInput, record: ReceiptRecord): DeviceState {
  return {
    ...device,
    syncedSeq: Math.max(device.syncedSeq, receipt.deviceSeq),
    receipts: [...device.receipts, record],
  };
}

/* --------------------------------- Reducer -------------------------------- */

export function runbookReducer(state: RunbookState = initialRunbookState, action: RunbookAction): RunbookState {
  switch (action.type) {
    case 'FREEZE': {
      if (state.show) return pushLog(state, action.at, '已存在冻结运行版，忽略重复冻结。');
      const show = freezeShow(action.input, action.at);
      let next: RunbookState = { ...state, show };
      next = pushLog(
        next,
        action.at,
        `已冻结《${action.input.title}》为演出运行版 v1：台词 ${action.input.lines.length} 条、舞台提示 ${action.input.cues.length} 条，顺序各自独立编号。`,
      );
      return next;
    }

    case 'BEGIN_REVISION': {
      if (!state.show || state.show.closed) return state;
      if (state.revision) return state;
      return { ...state, revision: beginRevision(state.show, action.note, action.at) };
    }

    case 'UPDATE_REVISION': {
      if (!state.revision) return state;
      return { ...state, revision: { ...action.revision, openedAt: state.revision.openedAt } };
    }

    case 'CANCEL_REVISION': {
      if (!state.revision) return state;
      return { ...state, revision: null };
    }

    case 'CONFIRM_REVISION': {
      if (!state.show || state.show.closed || !state.revision) return state;
      const result = confirmRevision(
        state.show,
        action.note,
        action.lines,
        action.cues,
        action.confirmedBy,
        action.at,
      );
      let next: RunbookState = {
        ...state,
        show: result.show,
        revision: null,
      };
      const currentSeq = state.show.activeVersionSeq;
      next = pushLog(
        next,
        action.at,
        `舞台监督 ${action.confirmedBy} 确认换序，运行版 v${currentSeq} → v${result.show.activeVersionSeq}：` +
          `作废未执行提示 ${result.voided.length} 条（已执行记录保留在 v${currentSeq}），新版本承接/新增提示 ${result.carried.length} 条并重新编号。`,
      );
      return next;
    }

    case 'QUEUE_RECEIPT': {
      if (!state.show || state.show.closed) return state;
      const device = state.devices[action.input.deviceId];
      const producedCounter = device.producedCounter + 1;
      const item: OutboxItem = {
        deviceId: action.input.deviceId,
        deviceSeq: producedCounter,
        cueId: action.input.cueId,
        producedAt: action.input.producedAt ?? action.at,
        queuedAt: action.at,
      };
      const nextDevice: DeviceState = {
        ...device,
        producedCounter,
        outbox: [...device.outbox, item],
      };
      let next: RunbookState = {
        ...state,
        devices: { ...state.devices, [item.deviceId]: nextDevice },
      };
      next = pushLog(
        next,
        action.at,
        `${item.deviceId} 产生回执 #${item.deviceSeq}（提示 ${item.cueId}），${device.online ? '立即上传' : '离线暂存，恢复后从断点续传'}。`,
      );
      // 在线：立即尝试上传（只传队首，逐条按序合并）
      if (device.online) {
        next = flushOne(next, item.deviceId, action.at);
      }
      return next;
    }

    case 'RESEND_RECEIPT': {
      if (!state.show) return state;
      const device = state.devices[action.deviceId];
      const original = device.receipts.find((item) => item.deviceSeq === action.deviceSeq);
      if (!original) {
        return pushLog(state, action.at, `${action.deviceId} 无法重发 #${action.deviceSeq}：台账中没有该序号回执。`);
      }
      // 直接走合并函数：同一设备序号已存在，必然判 DUP，状态不变。
      const result = mergeReceipt(
        state.show,
        device,
        {
          deviceId: original.deviceId,
          deviceSeq: original.deviceSeq,
          cueId: original.cueId,
          producedAt: original.producedAt,
        },
        action.at,
      );
      let next: RunbookState = {
        ...state,
        devices: { ...state.devices, [action.deviceId]: result.device },
      };
      next = pushLog(
        next,
        action.at,
        `${action.deviceId} 网络重发回执 #${action.deviceSeq}：重复回执只算一次，执行状态不改变。`,
      );
      return next;
    }

    case 'FLUSH_DEVICE': {
      if (!state.show) return state;
      const device = state.devices[action.deviceId];
      if (device.online === false) return pushLog(state, action.at, `${action.deviceId} 仍处于离线，暂不续传。`);
      if (device.outbox.length === 0) return state;
      let next = state;
      // 逐条按设备序号上传；flushOne 遇到缺号/硬拒绝时返回同一引用即停止。
      let guard = device.outbox.length + 1;
      while (guard-- > 0) {
        if (next.devices[action.deviceId].outbox.length === 0) break;
        const before = next;
        next = flushOne(next, action.deviceId, action.at);
        if (next === before) break;
      }
      return next;
    }

    case 'SET_DEVICE_ONLINE': {
      const device = state.devices[action.deviceId];
      if (device.online === action.online) return state;
      let next: RunbookState = {
        ...state,
        devices: {
          ...state.devices,
          [action.deviceId]: { ...device, online: action.online },
        },
      };
      next = pushLog(next, action.at, `${action.deviceId} ${action.online ? '网络恢复，从断点 #' + device.syncedSeq + ' 续传' : '进入离线'}。`);
      if (action.online && state.show && !state.show.closed) {
        // 纯函数自调用：复用 FLUSH_DEVICE 的按序续传逻辑
        next = runbookReducer(next, { type: 'FLUSH_DEVICE', deviceId: action.deviceId, at: action.at });
      }
      return next;
    }

    case 'CLOSE_SHOW': {
      if (!state.show || state.show.closed) return state;
      let next: RunbookState = {
        ...state,
        show: { ...state.show, closed: true, closedAt: action.at },
      };
      next = pushLog(next, action.at, '演出结束，运行版封存；各版本执行记录仍可查询，新回执一律拒绝。');
      return next;
    }

    default:
      return state;
  }
}

/** 上传并合并队首一条回执（按设备序号对齐）。 */
function flushOne(state: RunbookState, deviceId: DeviceId, at: string): RunbookState {
  if (!state.show) return state;
  const device = state.devices[deviceId];
  const head = device.outbox[0];
  if (!head) return state;

  // 设备序号对齐：队首必须是 syncedSeq + 1，否则保留在队列里等待（返回同一引用）。
  if (head.deviceSeq !== device.syncedSeq + 1) {
    return state;
  }

  const receipt: ReceiptInput = {
    deviceId: head.deviceId,
    deviceSeq: head.deviceSeq,
    cueId: head.cueId,
    producedAt: head.producedAt,
  };
  const result = mergeReceipt(state.show, device, receipt, at);
  // GAP（缺号）/ REJECTED（演出已结束）：不出队、不推进断点，返回同一引用让续传停止。
  if (result.record.outcome === 'GAP' || result.record.outcome === 'REJECTED') {
    return state;
  }
  const outbox = device.outbox.slice(1);
  const nextDevice: DeviceState = { ...result.device, outbox };
  let next: RunbookState = {
    ...state,
    show: result.show,
    devices: { ...state.devices, [deviceId]: nextDevice },
  };
  next = pushLog(next, at, formatReceiptMessage(deviceId, head, result.record.outcome));
  return next;
}

function formatReceiptMessage(deviceId: DeviceId, item: OutboxItem, outcome: MergeOutcome): string {
  const prefix = `${deviceId} 回执 #${item.deviceSeq}（提示 ${item.cueId}）合并：`;
  switch (outcome) {
    case 'APPLIED':
      return `${prefix}落锤成功，提示标记已执行。`;
    case 'DUP':
      return `${prefix}重复回执，只算一次，不重复执行。`;
    case 'ALREADY_DONE':
      return `${prefix}提示此前已执行，幂等忽略。`;
    case 'LATE_STALE':
      return `${prefix}迟到/错序回执（指向已作废或旧版本提示），仅登记台账，不盖到新顺序。`;
    case 'GAP':
      return `${prefix}设备序号缺口，拒绝合并。`;
    case 'UNKNOWN_CUE':
      return `${prefix}找不到对应提示行，拒绝合并。`;
    default:
      return `${prefix}被拒绝（演出可能已结束）。`;
  }
}

/* ------------------------------ 视角过滤/查询 ------------------------------ */

/**
 * 岗位视角过滤：
 * - SM（舞台监督）可见全部口令；
 * - LIGHT / SOUND / STAGE 各自只能看到本岗位提示；
 * - 因此场务（STAGE）永远看不到灯光口令，离线与演出结束后同样不可见。
 */
export function visibleCuesForRole(version: RunVersion, role: ConsoleRole): RunCue[] {
  return filterCuesByRole(version.cues, role);
}

export function filterCuesByRole(cues: RunCue[], role: ConsoleRole): RunCue[] {
  if (role === 'SM') return cues;
  return cues.filter((cue) => cue.kind === (role as CueKind));
}

export const ALL_CUE_KINDS = CUE_KINDS;
export const ALL_CONSOLE_ROLES = CONSOLE_ROLES;
