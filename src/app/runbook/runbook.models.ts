/**
 * 演出运行版（Show Running Book）领域模型。
 * 纯 TypeScript，不依赖 Angular/NgRx，便于在 Node 下做单测。
 */

/** 舞台提示类别（与设备/岗位对应） */
export type CueKind = 'LIGHT' | 'SOUND' | 'STAGE';

export const CUE_KINDS: readonly CueKind[] = ['LIGHT', 'SOUND', 'STAGE'] as const;

/** 提示执行状态：待执行 / 已执行 / 因换序而作废（仅出现在旧版本中） */
export type CueStatus = 'PENDING' | 'DONE' | 'VOID';

/** 工作台视角。场务（STAGE）看不到灯光口令。 */
export type ConsoleRole = 'SM' | 'LIGHT' | 'SOUND' | 'STAGE';

export const CONSOLE_ROLES: readonly ConsoleRole[] = ['SM', 'LIGHT', 'SOUND', 'STAGE'] as const;

/** 设备类型，与提示类别对齐 */
export type DeviceId = 'LIGHT-01' | 'SOUND-01' | 'STAGE-01';

export const DEVICE_IDS: readonly DeviceId[] = ['LIGHT-01', 'SOUND-01', 'STAGE-01'] as const;

export function cueKindOfDevice(deviceId: DeviceId): CueKind {
  return deviceId.slice(0, 5) as CueKind;
}

/** 冻结输入中的角色台词 */
export interface FreezeLineInput {
  role: string;
  text: string;
}

/** 冻结输入中的舞台提示（类别必须显式给出，避免靠关键字猜测） */
export interface FreezeCueInput {
  kind: CueKind;
  label: string;
  detail: string;
}

export interface FreezeInput {
  title: string;
  frozenFrom: string;
  lines: FreezeLineInput[];
  cues: FreezeCueInput[];
}

/** 角色台词快照。台词在运行版中不接受执行回执，只保留顺序。 */
export interface RunLine {
  seq: number;
  role: string;
  text: string;
}

/**
 * 舞台提示快照。
 * - seq：在“所属版本”内独立编号（1 起，连续），与台词序号各自独立。
 * - lineageId：跨版本的同一提示血缘；换序重算后新行继承旧行血缘。
 * - status / executedAt / receiptDeviceSeq 只可能出现在该提示所属版本中。
 */
export interface RunCue {
  id: string;
  lineageId: string;
  versionSeq: number;
  seq: number;
  kind: CueKind;
  label: string;
  detail: string;
  status: CueStatus;
  executedAt: string | null;
  /** 落锤回执在其设备上的序号（设备自身计序，非顺序号） */
  receiptDeviceSeq: number | null;
}

export interface RunVersion {
  /** 自增版本号，从 1 开始 */
  versionSeq: number;
  createdAt: string;
  /** 换序说明（v1 为冻结来源，之后为导演临时改动说明） */
  note: string;
  /** 舞台监督确认人；仅换序产生的版本有值 */
  confirmedBy: string | null;
  /** 该版本存活时的台词全量顺序（不保留作废标记） */
  lines: RunLine[];
  /**
   * 该版本的提示行：
   * - 换序确认后，旧版本未执行提示标记 VOID；
   * - 已执行提示不会复制到新版本，其不可变记录永远留在所属旧版本中。
   */
  cues: RunCue[];
}

export interface RunShow {
  title: string;
  frozenFrom: string;
  frozenAt: string;
  /** 当前有效版本号 */
  activeVersionSeq: number;
  versions: RunVersion[];
  /** 演出是否已结束；结束后只读，执行记录仍可逐版本查询 */
  closed: boolean;
  closedAt: string | null;
  /** 血缘自增计数 */
  lineageCounter: number;
  /** 提示行自增计数（全版本唯一 id） */
  cueIdCounter: number;
}

/** 回执合并结果 */
export type MergeOutcome =
  | 'APPLIED'        // 落锤：把当前顺序上的待执行提示标记为已执行
  | 'DUP'            // 重复回执（设备序号相同），只算一次
  | 'ALREADY_DONE'   // 同提示的另一序号回执：提示早已执行，幂等忽略
  | 'LATE_STALE'     // 迟到回执：指向作废提示/旧版本/错误类别，不得盖到新顺序
  | 'UNKNOWN_CUE'    // 找不到该提示行（数据错误）
  | 'GAP'            // 设备序号出现空洞（不是期望的下一号）
  | 'REJECTED';      // 演出已结束等硬性拒绝

/** 设备上报的原始回执（客户端先入本地离线上报队列，再上传） */
export interface ReceiptInput {
  deviceId: DeviceId;
  /** 设备自身分配的单调序号（每台设备独立从 1 计起） */
  deviceSeq: number;
  /** 执行时操作员认定的提示行 id（可能是旧版本上已作废的行） */
  cueId: string;
  producedAt: string;
}

/** 合并后的不可变回执台账 */
export interface ReceiptRecord extends ReceiptInput {
  /** 实际上传合并时间 */
  receivedAt: string;
  outcome: MergeOutcome;
  /** 落锤时实际命中的提示行 id（APPLIED 时等于 cueId） */
  appliedCueId: string | null;
  /** 命中时的版本号，便于演出后按版本回溯 */
  versionSeq: number | null;
}

export interface OutboxItem extends ReceiptInput {
  /** 客户端入队时间 */
  queuedAt: string;
}

export interface DeviceState {
  deviceId: DeviceId;
  online: boolean;
  /** 客户端已分配到的最大序号（离线上报也会推进） */
  producedCounter: number;
  /** 待上传的离线上报队列，按 deviceSeq 升序 */
  outbox: OutboxItem[];
  /** 服务端已确认合并到的最大设备序号；断点续传从这里之后继续 */
  syncedSeq: number;
  /** 合并日志（按合并顺序追加） */
  receipts: ReceiptRecord[];
}

/** 换序草稿中的台词行（仅文本可改、顺序可调） */
export interface RevisionLineDraft {
  role: string;
  text: string;
}

/** 换序草稿中的提示行。lineageId 为 null 表示导演新增提示。 */
export interface RevisionCueDraft {
  lineageId: number | null;
  kind: CueKind;
  label: string;
  detail: string;
}

export interface OrderRevision {
  note: string;
  lines: RevisionLineDraft[];
  cues: RevisionCueDraft[];
  openedAt: string;
}

export interface RunbookState {
  show: RunShow | null;
  revision: OrderRevision | null;
  devices: Record<DeviceId, DeviceState>;
  /** 全局操作日志（中文），含错误拒绝记录 */
  log: Array<{ at: string; message: string }>;
}

/** 运行台动作（reducer 用判别联合） */
export type RunbookAction =
  | { type: 'FREEZE'; input: FreezeInput; at: string }
  | { type: 'BEGIN_REVISION'; note: string; at: string }
  | { type: 'UPDATE_REVISION'; revision: Omit<OrderRevision, 'openedAt'> }
  | { type: 'CANCEL_REVISION' }
  | {
      type: 'CONFIRM_REVISION';
      note: string;
      lines: RevisionLineDraft[];
      cues: RevisionCueDraft[];
      confirmedBy: string;
      at: string;
    }
  | { type: 'QUEUE_RECEIPT'; input: Omit<ReceiptInput, 'deviceSeq' | 'producedAt'> & { producedAt?: string }; at: string }
  /** 模拟网络链路重发：把设备已合并过的某个序号原样再传一次，验证“重复回执只算一次” */
  | { type: 'RESEND_RECEIPT'; deviceId: DeviceId; deviceSeq: number; at: string }
  | { type: 'FLUSH_DEVICE'; deviceId: DeviceId; at: string }
  | { type: 'SET_DEVICE_ONLINE'; deviceId: DeviceId; online: boolean; at: string }
  | { type: 'CLOSE_SHOW'; at: string };
