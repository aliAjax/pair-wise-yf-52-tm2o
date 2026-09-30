/* 纯 Node 验证（tsc 编译后执行）：覆盖冻结/换序/离线续传/去重/迟到隔离/视角/封存 */
import { activeVersion, beginRevision, mergeReceipt, visibleCuesForRole, runbookReducer } from './runbook.logic';
import { RunbookState, DeviceId, RevisionCueDraft } from './runbook.models';
import { SEED_SCRIPT } from './runbook.seed';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error('  ✗ ' + msg); }
  else console.log('  ✓ ' + msg);
}

let s: RunbookState = runbookReducer(undefined as unknown as RunbookState, { type: 'FREEZE', input: SEED_SCRIPT, at: 't0' });
const show = () => s.show!;
const v = () => activeVersion(show());
const dev = (id: DeviceId) => s.devices[id];

console.log('1. 冻结运行版');
assert(show().activeVersionSeq === 1, '当前版本为 v1');
assert(v().lines.length === 5 && v().lines[0].seq === 1 && v().lines[4].seq === 5, '台词顺序独立编号 1..5');
assert(v().cues.length === 8 && v().cues[0].seq === 1 && v().cues[7].seq === 8, '舞台提示顺序独立编号 1..8');
assert(v().cues[0].id === 'cue-1' && v().cues[0].lineageId === 'L1', '提示有稳定 id 与血缘号');
assert(v().cues.every((c) => c.status === 'PENDING'), '全部提示待执行');

console.log('2. 在线落锤');
s = runbookReducer(s, { type: 'QUEUE_RECEIPT', input: { deviceId: 'LIGHT-01', cueId: 'cue-1' }, at: 't1' });
assert(dev('LIGHT-01').syncedSeq === 1 && dev('LIGHT-01').outbox.length === 0, '在线回执即时合并，队列为空');
assert(v().cues[0].status === 'DONE' && v().cues[0].receiptDeviceSeq === 1, 'cue-1 已执行并记录设备序号 #1');
s = runbookReducer(s, { type: 'QUEUE_RECEIPT', input: { deviceId: 'SOUND-01', cueId: 'cue-2' }, at: 't2' });
assert(v().cues[1].status === 'DONE', 'cue-2 音效已执行');

console.log('3. 离线产生回执 + 重发去重');
s = runbookReducer(s, { type: 'SET_DEVICE_ONLINE', deviceId: 'LIGHT-01', online: false, at: 't3' });
s = runbookReducer(s, { type: 'QUEUE_RECEIPT', input: { deviceId: 'LIGHT-01', cueId: 'cue-4' }, at: 't4' });
s = runbookReducer(s, { type: 'QUEUE_RECEIPT', input: { deviceId: 'LIGHT-01', cueId: 'cue-7' }, at: 't5' });
assert(dev('LIGHT-01').producedCounter === 3 && dev('LIGHT-01').outbox.length === 2, '离线仍计序：#2 #3 入待传队列');
s = runbookReducer(s, { type: 'RESEND_RECEIPT', deviceId: 'LIGHT-01', deviceSeq: 1, at: 't6' });
assert(dev('LIGHT-01').receipts.filter((r) => r.deviceSeq === 1).length === 1, '重发 #1 重复回执只算一次（台账仍只有一条）');
assert(v().cues[0].executedAt === 't1', '重复回执未覆盖原始执行时间');

console.log('4. 断网恢复，断点续传');
s = runbookReducer(s, { type: 'SET_DEVICE_ONLINE', deviceId: 'LIGHT-01', online: true, at: 't7' });
assert(dev('LIGHT-01').outbox.length === 0 && dev('LIGHT-01').syncedSeq === 3, '恢复后队列清空，断点推进到 #3');
assert(v().cues.find((c) => c.id === 'cue-4')!.status === 'DONE', 'cue-4 续传落锤');
assert(v().cues.find((c) => c.id === 'cue-7')!.status === 'DONE', 'cue-7 续传落锤');

console.log('5. 音效离线产生旧顺序回执，等待导演换序');
s = runbookReducer(s, { type: 'SET_DEVICE_ONLINE', deviceId: 'SOUND-01', online: false, at: 't8' });
s = runbookReducer(s, { type: 'QUEUE_RECEIPT', input: { deviceId: 'SOUND-01', cueId: 'cue-5' }, at: 't9' });
assert(dev('SOUND-01').outbox[0].deviceSeq === 2, 'SOUND #2（旧顺序 cue-5）离线暂存');

console.log('6. 舞台监督确认换序：删 cue-3 血缘、cue-7 已执行不可编辑、重排并新增灯光提示');
s = runbookReducer(s, { type: 'BEGIN_REVISION', note: '导演临时调整：删场务撤椅、新增定点光、尾场追光前提', at: 't10' });
const draft = beginRevision(show(), '导演临时调整：删场务撤椅、新增定点光、尾场追光前提', 't10');
const editCues: RevisionCueDraft[] = [];
// 新顺序：新增灯光 Lnew、旧 cue-7 血缘(已执行，不会出现在草稿) — 草稿只含 PENDING
assert(draft.cues.find((c) => c.lineageId === 7) === undefined, '已执行的 cue-7 血缘不进入草稿（历史保留）');
assert(!!draft.cues.find((c) => c.lineageId === 3), '待执行的 cue-3 在场可被删除');
// 删除 lineage 3；保留 5/6/8；新增一条灯光
for (const c of draft.cues) {
  if (c.lineageId === 3) continue;
  editCues.push(c);
}
// 重排：cue-8 血缘(L8)排到最前，再 5、6；末尾新增
editCues.sort((a, b) => (a.lineageId === 8 ? -1 : b.lineageId === 8 ? 1 : 0));
editCues.push({ lineageId: null, kind: 'LIGHT', label: '新增定点光', detail: '周野独白时门区冷光定点 15 秒' });
s = runbookReducer(s, {
  type: 'CONFIRM_REVISION',
  note: '导演临时：删撤椅提示、尾场音效前提、新增定点光',
  lines: SEED_SCRIPT.lines.slice(0, 4), // 导演删掉最后一句台词
  cues: editCues,
  confirmedBy: '王监督',
  at: 't11',
});
assert(show().activeVersionSeq === 2, '当前版本推进到 v2');
const v1 = () => show().versions[0];
const v2 = () => show().versions[1];
assert(v1().cues.find((c) => c.id === 'cue-3')!.status === 'VOID', 'v1 未执行且被删除的 cue-3 标记作废');
assert(['cue-1', 'cue-2', 'cue-4', 'cue-7'].every((id) => v1().cues.find((c) => c.id === id)!.status === 'DONE'), 'v1 已执行提示全部保留为 DONE');
assert(v1().cues.find((c) => c.id === 'cue-5')!.status === 'PENDING', 'v1 被沿用血缘的旧行留在 v1（不再是当前顺序）');
assert(v2().cues.length === 4, 'v2 承接 3 条（L5/L6/L8）+ 新增 1 条');
assert(v2().cues[0].lineageId === 'L8' && v2().cues[0].seq === 1 && v2().cues[0].status === 'PENDING', 'v2 重新编号：L8 排第 1 且回到待执行');
assert(v2().cues[3].lineageId === 'L9' && v2().cues[3].kind === 'LIGHT', '新增提示取得新血缘 L9');
assert(v2().lines.length === 4 && v2().lines[3].seq === 4, '台词删改后重新连续编号');

console.log('7. 迟到回执不得盖到新顺序');
s = runbookReducer(s, { type: 'SET_DEVICE_ONLINE', deviceId: 'SOUND-01', online: true, at: 't12' });
const stale = dev('SOUND-01').receipts.find((r) => r.deviceSeq === 2)!;
assert(stale.outcome === 'LATE_STALE' && stale.appliedCueId === null, '旧顺序 cue-5 回执判迟到隔离，不落锤');
assert(dev('SOUND-01').syncedSeq === 2, '迟到回执仍按序登记并推进断点');
assert(v2().cues.find((c) => c.lineageId === 'L5')!.status === 'PENDING', '新顺序上的 L5 行未被迟到回执盖写');
assert(v1().cues.find((c) => c.id === 'cue-5')!.status === 'PENDING', '旧版 cue-5 维持原样');

console.log('8. 恢复后新回执在新顺序上正常执行');
const newL5 = v2().cues.find((c) => c.lineageId === 'L5')!.id;
s = runbookReducer(s, { type: 'QUEUE_RECEIPT', input: { deviceId: 'SOUND-01', cueId: newL5 }, at: 't13' });
assert(dev('SOUND-01').syncedSeq === 3 && v2().cues.find((c) => c.id === newL5)!.status === 'DONE', '#3 在 v2 新顺序落锤 L5');

console.log('9. 岗位视角隔离');
assert(visibleCuesForRole(v2(), 'STAGE').every((c) => c.kind === 'STAGE'), '场务视角只有场务提示');
assert(visibleCuesForRole(v2(), 'STAGE').find((c) => c.kind === 'LIGHT') === undefined, '场务看不到任何灯光口令（含新增定点光）');
assert(visibleCuesForRole(v2(), 'LIGHT').every((c) => c.kind === 'LIGHT'), '灯光台只看灯光');
assert(visibleCuesForRole(v2(), 'SM').length === v2().cues.length, '舞台监督可见全部');

console.log('10. 设备序号缺口防护（直接调用合并）');
const gap = mergeReceipt(show(), dev('STAGE-01'), { deviceId: 'STAGE-01', deviceSeq: 9, cueId: 'cue-6', producedAt: 'x' }, 't16');
assert(gap.record.outcome === 'GAP' && gap.device.syncedSeq === 0, '乱序序号 #9 判 GAP，不出账不推进');

console.log('11. 演出结束：封存与历史版本查询');
s = runbookReducer(s, { type: 'CLOSE_SHOW', at: 't14' });
assert(show().closed === true, '演出已结束');
const before = JSON.stringify(s);
s = runbookReducer(s, { type: 'QUEUE_RECEIPT', input: { deviceId: 'STAGE-01', cueId: v2().cues[0].id }, at: 't15' });
assert(JSON.stringify(s) === before, '结束后新回执被拒绝，状态不变');
assert(show().versions.length === 2, '仍可查询 v1/v2 两个版本的执行记录');
assert(v1().cues.filter((c) => c.status === 'DONE').length === 4 && v2().cues.filter((c) => c.status === 'DONE').length === 1, '各版本执行记录完整保留');

console.log(failures === 0 ? '\n全部通过 ✓' : `\n有 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
