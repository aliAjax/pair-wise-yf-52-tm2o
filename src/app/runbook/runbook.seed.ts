import { FreezeInput } from './runbook.models';

/** 开演前待冻结的当前剧本（模拟导演手中的最新排练稿） */
export const SEED_SCRIPT: FreezeInput = {
  title: '《灯不会等我们》',
  frozenFrom: '排练稿 v13',
  lines: [
    { role: '周野', text: '灯还没暗，你们就让我上场？' },
    { role: '周岚', text: '你每次都说等明天，可舞台不会等我们。' },
    { role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。' },
    { role: '周岚', text: '看着灯，再说一次你为什么回来。' },
    { role: '周野', text: '因为幕布一拉开，我们都没有退路。' },
  ],
  cues: [
    { kind: 'LIGHT', label: '开演前 3 分钟', detail: '观众厅灯渐暗至 30%，台口脚灯点亮' },
    { kind: 'SOUND', label: '开场', detail: '雨声环境音 5 秒渐入至 -12dB' },
    { kind: 'STAGE', label: '周野首次上场前', detail: '撤去侧台备用椅子，确认地胶无痕' },
    { kind: 'LIGHT', label: '第三场', detail: '侧灯收至 30%，留一束冷白顶光' },
    { kind: 'SOUND', label: '第三场静默后', detail: '远雷一记，延迟 1.2 秒回声' },
    { kind: 'STAGE', label: '三场转四场黑场', detail: '8 秒内将沙发移至右前区，茶几反向' },
    { kind: 'LIGHT', label: '尾场独白', detail: '追光由冷白切琥珀，其余灯全收' },
    { kind: 'SOUND', label: '尾声收光', detail: '雨声随收光 6 秒淡出至无声' },
  ],
};

export const KIND_LABEL: Record<string, string> = {
  LIGHT: '灯光',
  SOUND: '音效',
  STAGE: '场务',
};

export const ROLE_LABEL: Record<string, string> = {
  SM: '舞台监督',
  LIGHT: '灯光台',
  SOUND: '音效台',
  STAGE: '场务台',
};

export const STATUS_LABEL: Record<string, string> = {
  PENDING: '待执行',
  DONE: '已执行',
  VOID: '已作废',
};

export const OUTCOME_LABEL: Record<string, string> = {
  APPLIED: '落锤执行',
  DUP: '重复忽略',
  ALREADY_DONE: '幂等忽略',
  LATE_STALE: '迟到隔离',
  UNKNOWN_CUE: '未知提示',
  GAP: '序号缺口',
  REJECTED: '已拒绝',
};
