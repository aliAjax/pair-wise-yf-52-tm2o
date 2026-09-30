import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Store } from '@ngrx/store';
import { Subscription } from 'rxjs';
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
} from './runbook.actions';
import { persistRunbook } from './runbook.feature';
import { activeVersion, visibleCuesForRole } from './runbook.logic';
import {
  CONSOLE_ROLES,
  ConsoleRole,
  CUE_KINDS,
  CueKind,
  DeviceId,
  DEVICE_IDS,
  RunCue,
  RunVersion,
  RunbookState,
} from './runbook.models';
import { KIND_LABEL, OUTCOME_LABEL, ROLE_LABEL, SEED_SCRIPT, STATUS_LABEL } from './runbook.seed';

interface EditLine { key: number; role: string; text: string }
interface EditCue { key: number; lineageId: number | null; kind: CueKind; label: string; detail: string }

@Component({
  selector: 'app-runbook',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatChipsModule,
    MatTabsModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  template: `
    <div class="rb">
      <!-- 冻结前：展示当前剧本，等待舞台监督冻结 -->
      <section *ngIf="!state?.show" class="freeze-wrap">
        <mat-card class="freeze-card">
          <h2>开演冻结：当前剧本 → 演出运行版</h2>
          <p class="hint">
            冻结后角色台词与舞台提示将分别获得独立执行顺序（台词 L#、提示 Q#）。
            演出中导演再删台词、换顺序，以“版本”为准，不再靠口头传话。
          </p>
          <div class="seed-grid">
            <div>
              <h3>角色台词（{{ seed.lines.length }}）</h3>
              <div class="seed-line" *ngFor="let line of seed.lines; let i = index">
                <span class="seq">L{{ i + 1 }}</span><b>{{ line.role }}</b>：{{ line.text }}
              </div>
            </div>
            <div>
              <h3>舞台提示（{{ seed.cues.length }}）</h3>
              <div class="seed-line" *ngFor="let cue of seed.cues; let i = index">
                <span class="seq">Q{{ i + 1 }}</span>
                <span class="kind-tag" [class.kind-LIGHT]="cue.kind==='LIGHT'" [class.kind-SOUND]="cue.kind==='SOUND'" [class.kind-STAGE]="cue.kind==='STAGE'">{{ kindLabel(cue.kind) }}</span>
                <b>{{ cue.label }}</b>：{{ cue.detail }}
              </div>
            </div>
          </div>
          <button mat-flat-button color="primary" class="freeze-btn" (click)="freeze()">
            <mat-icon>ac_unit</mat-icon> 确认冻结为演出运行版 v1
          </button>
        </mat-card>
      </section>

      <ng-container *ngIf="state?.show as show">
        <!-- 运行版头部 -->
        <mat-card class="head-card">
          <div class="head-row">
            <div>
              <h2>{{ show.title }} · 演出运行版
                <span class="ver-badge">当前 v{{ show.activeVersionSeq }}</span>
                <span class="closed-badge" *ngIf="show.closed">演出已结束（只读封存）</span>
              </h2>
              <p class="sub">冻结自 {{ show.frozenFrom }} · 冻结时间 {{ show.frozenAt }} · 共 {{ show.versions.length }} 个顺序版本</p>
            </div>
            <div class="head-actions">
              <button mat-stroked-button color="primary" [disabled]="show.closed || !!state?.revision" (click)="openRevision()">
                <mat-icon>edit_note</mat-icon> 导演临时改顺序
              </button>
              <button mat-stroked-button color="warn" *ngIf="!show.closed" (click)="closeShow()">
                <mat-icon>stop_circle</mat-icon> 结束演出
              </button>
              <button mat-stroked-button (click)="resetAll()"><mat-icon>restart_alt</mat-icon> 重置演练</button>
            </div>
          </div>
          <div class="version-tabs">
            <button mat-stroked-button
              *ngFor="let version of show.versions"
              [color]="viewingVersion(show) === version.versionSeq ? 'primary' : ''"
              (click)="viewVersionSeq = version.versionSeq">
              v{{ version.versionSeq }}
              <span class="tab-sub">
                {{ version.versionSeq === show.activeVersionSeq ? '当前' : ('作废' + voidCount(version) + ' · 已执行' + doneCount(version)) }}
              </span>
            </button>
          </div>
        </mat-card>

        <!-- 换序草稿编辑器 -->
        <mat-card *ngIf="state?.revision && editorActive" class="revise-card">
          <h2>换序草稿（尚未生效）<span class="warn-note">确认后：未执行提示作废重算，已执行提示永久保留在旧版本</span></h2>
          <div class="revise-grid">
            <div>
              <h3>角色台词（执行顺序）</h3>
              <div class="edit-row" *ngFor="let line of editLines; let i = index">
                <span class="seq">L{{ i + 1 }}</span>
                <input class="role-input" [(ngModel)]="line.role" placeholder="角色" aria-label="角色">
                <input class="text-input" [(ngModel)]="line.text" placeholder="台词" aria-label="台词">
                <button mat-icon-button [disabled]="i===0" (click)="move(editLines, i, -1)"><mat-icon>arrow_upward</mat-icon></button>
                <button mat-icon-button [disabled]="i===editLines.length-1" (click)="move(editLines, i, 1)"><mat-icon>arrow_downward</mat-icon></button>
                <button mat-icon-button color="warn" (click)="editLines.splice(i,1)"><mat-icon>delete</mat-icon></button>
              </div>
              <button mat-stroked-button (click)="addLine()"><mat-icon>add</mat-icon>加台词</button>
            </div>
            <div>
              <h3>舞台提示（执行顺序，已执行提示不在此列）</h3>
              <div class="edit-cue" *ngFor="let cue of editCues; let i = index">
                <div class="edit-cue-head">
                  <span class="seq">Q{{ i + 1 }}</span>
                  <span class="lineage" [class.new]="cue.lineageId===null">{{ cue.lineageId===null ? '新增' : '血缘 L'+cue.lineageId }}</span>
                  <mat-form-field appearance="outline" class="kind-select">
                    <mat-select [(ngModel)]="cue.kind">
                      <mat-option *ngFor="let k of cueKinds" [value]="k">{{ kindLabel(k) }}</mat-option>
                    </mat-select>
                  </mat-form-field>
                  <span class="spacer"></span>
                  <button mat-icon-button [disabled]="i===0" (click)="move(editCues, i, -1)"><mat-icon>arrow_upward</mat-icon></button>
                  <button mat-icon-button [disabled]="i===editCues.length-1" (click)="move(editCues, i, 1)"><mat-icon>arrow_downward</mat-icon></button>
                  <button mat-icon-button color="warn" (click)="editCues.splice(i,1)"><mat-icon>delete</mat-icon></button>
                </div>
                <input class="text-input wide" [(ngModel)]="cue.label" placeholder="提示名称（如：第三场）" aria-label="提示名称">
                <input class="text-input wide" [(ngModel)]="cue.detail" placeholder="执行内容" aria-label="执行内容">
              </div>
              <button mat-stroked-button (click)="addCue()"><mat-icon>add</mat-icon>加提示</button>
            </div>
          </div>
          <div class="revise-foot">
            <mat-form-field appearance="outline" class="note-input">
              <mat-label>改动说明</mat-label>
              <input matInput [(ngModel)]="editNote">
            </mat-form-field>
            <mat-form-field appearance="outline" class="name-input">
              <mat-label>舞台监督确认人</mat-label>
              <input matInput [(ngModel)]="confirmName">
            </mat-form-field>
            <button mat-stroked-button (click)="cancelRevision()">取消</button>
            <button mat-flat-button color="primary" [disabled]="!confirmName.trim()" (click)="confirmRevision()">
              <mat-icon>verified</mat-icon> 舞台监督确认并发布新顺序
            </button>
          </div>
        </mat-card>

        <div class="run-grid">
          <!-- 左：运行板 -->
          <mat-card class="board-card">
            <div class="board-head">
              <h2>运行板
                <span class="ver-badge" *ngIf="viewingVersion(show)!==show.activeVersionSeq">查看 v{{ viewingVersion(show) }}（历史）</span>
              </h2>
              <div class="role-switch">
                <span class="role-label">岗位视角：</span>
                <button mat-stroked-button *ngFor="let r of consoleRoles"
                  [color]="viewRole===r ? 'primary' : ''"
                  (click)="viewRole=r">{{ roleLabel(r) }}</button>
              </div>
            </div>
            <p class="version-note">
              {{ viewing(show).note }}
              <span *ngIf="viewing(show).confirmedBy">· 确认人：{{ viewing(show).confirmedBy }}</span>
              · {{ viewing(show).createdAt }}
            </p>
            <p class="role-hint" *ngIf="viewRole!=='SM'">当前为{{ roleLabel(viewRole) }}视角，仅显示本岗位口令。</p>

            <mat-tab-group>
              <mat-tab [label]="'角色台词 ' + viewing(show).lines.length">
                <div class="run-line" *ngFor="let line of viewing(show).lines">
                  <span class="seq">L{{ line.seq }}</span>
                  <div><b>{{ line.role }}</b><p>{{ line.text }}</p></div>
                </div>
              </mat-tab>
              <mat-tab [label]="'舞台提示 ' + visibleCues(viewing(show)).length">
                <div class="run-cue" *ngFor="let cue of visibleCues(viewing(show))">
                  <span class="seq">Q{{ cue.seq }}</span>
                  <span class="kind-tag" [class.kind-LIGHT]="cue.kind==='LIGHT'" [class.kind-SOUND]="cue.kind==='SOUND'" [class.kind-STAGE]="cue.kind==='STAGE'">{{ kindLabel(cue.kind) }}</span>
                  <div class="cue-body">
                    <b>{{ cue.label }}</b>
                    <p>{{ cue.detail }}</p>
                    <div class="cue-meta">
                      <span class="status-tag st-{{ cue.status }}">{{ statusLabel(cue.status) }}</span>
                      <span class="lineage">血缘 {{ cue.lineageId }}</span>
                      <span *ngIf="cue.receiptDeviceSeq!==null">回执 #{{ cue.receiptDeviceSeq }} · {{ cue.executedAt }}</span>
                    </div>
                  </div>
                  <button mat-flat-button color="primary"
                    *ngIf="viewRole==='SM' || viewRole===cue.kind"
                    [disabled]="show.closed || cue.status!=='PENDING' || viewingVersion(show)!==show.activeVersionSeq"
                    [matTooltip]="(deviceOnline(cue.kind) ? '' : '设备离线：先入本地队列，恢复后按序续传')"
                    (click)="sendReceipt(cue)">
                    {{ kindLabel(cue.kind) }}台执行回执
                  </button>
                </div>
                <p class="empty" *ngIf="visibleCues(viewing(show)).length===0">该视角在此版本没有可见口令。</p>
              </mat-tab>
            </mat-tab-group>
          </mat-card>

          <!-- 右：设备与回执 -->
          <aside class="devices">
            <mat-card class="device-card" *ngFor="let id of deviceIds">
              <div class="device-head">
                <b>{{ id }}</b><span class="role-sub">{{ roleLabel(deviceRole(id)) }}</span>
                <span class="spacer"></span>
                <span class="net" [class.off]="!state!.devices[id].online">{{ state!.devices[id].online ? '在线' : '离线' }}</span>
              </div>
              <div class="device-actions">
                <button mat-stroked-button (click)="toggleOnline(id)">
                  {{ state!.devices[id].online ? '模拟断网' : '网络恢复' }}
                </button>
                <button mat-stroked-button [disabled]="state!.devices[id].online || state!.devices[id].outbox.length===0 || show.closed"
                  (click)="flush(id)">手动续传</button>
                <button mat-stroked-button [disabled]="state!.devices[id].receipts.length===0 || show.closed"
                  (click)="resendLast(id)">重发末条</button>
              </div>
              <div class="device-stats">
                <span>已发 {{ state!.devices[id].producedCounter }}</span>
                <span>合并断点 #{{ state!.devices[id].syncedSeq }}</span>
                <span [class.pending-outbox]="state!.devices[id].outbox.length>0">待传 {{ state!.devices[id].outbox.length }}</span>
              </div>
              <div class="outbox" *ngIf="state!.devices[id].outbox.length">
                <p>离线队列（恢复后从断点 #{{ state!.devices[id].syncedSeq }} 起按序上传）：</p>
                <div class="outbox-item" *ngFor="let item of state!.devices[id].outbox">
                  #{{ item.deviceSeq }} → {{ cueBrief(item.cueId) }}
                </div>
              </div>
              <div class="ledger">
                <p>回执台账（按设备序号对齐）：</p>
                <div class="ledger-item" *ngFor="let r of recent(id)" [class.row-stale]="r.outcome==='LATE_STALE'" [class.row-dup]="r.outcome==='DUP'">
                  <span class="ledger-seq">#{{ r.deviceSeq }}</span>
                  <span class="ledger-cue">{{ cueBrief(r.cueId) }}<small *ngIf="r.versionSeq!==null"> · v{{ r.versionSeq }}</small></span>
                  <span class="ledger-outcome oc-{{ r.outcome }}">{{ outcomeLabel(r.outcome) }}</span>
                </div>
                <p class="empty" *ngIf="state!.devices[id].receipts.length===0">暂无回执</p>
              </div>
            </mat-card>
          </aside>
        </div>

        <!-- 操作日志 -->
        <mat-card class="log-card">
          <h2>监督台日志 <small>迟到回执只登记不执行；演出结束后各版本记录仍在此与版本页可查</small></h2>
          <div class="log-item" *ngFor="let item of recentLogs()"><span class="log-at">{{ item.at }}</span>{{ item.message }}</div>
        </mat-card>
      </ng-container>
    </div>
  `,
  styleUrls: ['./runbook.component.css'],
})
export class RunbookComponent implements OnInit, OnDestroy {
  readonly seed = SEED_SCRIPT;
  readonly cueKinds = CUE_KINDS;
  readonly consoleRoles = CONSOLE_ROLES;
  readonly deviceIds = DEVICE_IDS;

  state: RunbookState | null = null;
  viewRole: ConsoleRole = 'SM';
  viewVersionSeq: number | null = null;

  editorActive = false;
  editLines: EditLine[] = [];
  editCues: EditCue[] = [];
  editNote = '';
  confirmName = '王监督';
  private editKey = 0;

  private subscription?: Subscription;

  constructor(private readonly store: Store<{ runbook: RunbookState }>) {}

  ngOnInit() {
    this.subscription = this.store.select('runbook').subscribe((state) => {
      this.state = state;
      persistRunbook(state);
      // 换序草稿在另一标签页打开/从缓存恢复时，同步本地编辑区
      if (state.revision && !this.editorActive) {
        this.hydrateEditor(state.revision.lines, state.revision.cues, state.revision.note);
      }
      if (!state.revision && this.editorActive) {
        this.clearEditor();
      }
    });
  }

  ngOnDestroy() {
    this.subscription?.unsubscribe();
  }

  /* ---------------------------------- 冻结 ---------------------------------- */
  freeze() {
    this.store.dispatch(rbFreeze({ input: SEED_SCRIPT }));
  }

  resetAll() {
    if (!window.confirm('清空当前运行版与所有回执，重新演练？')) return;
    this.viewVersionSeq = null;
    this.clearEditor();
    this.store.dispatch(rbReset());
  }

  closeShow() {
    if (!window.confirm('确认结束演出？结束后运行版只读，执行记录永久保留可查。')) return;
    this.store.dispatch(rbCloseShow());
  }

  /* --------------------------------- 换序草稿 -------------------------------- */
  openRevision() {
    if (!this.state?.show || this.state.revision) return;
    const note = '导演临时调整：删改台词 / 调整提示顺序';
    this.store.dispatch(rbBeginRevision({ note }));
    const base = activeVersion(this.state.show);
    this.hydrateEditor(
      base.lines.map((line) => ({ role: line.role, text: line.text })),
      base.cues
        .filter((cue) => cue.status === 'PENDING')
        .map((cue) => ({ lineageId: Number(cue.lineageId.slice(1)), kind: cue.kind, label: cue.label, detail: cue.detail })),
      note,
    );
  }

  private hydrateEditor(
    lines: Array<{ role: string; text: string }>,
    cues: Array<{ lineageId: number | null; kind: CueKind; label: string; detail: string }>,
    note: string,
  ) {
    this.editLines = lines.map((line) => ({ key: ++this.editKey, ...line }));
    this.editCues = cues.map((cue) => ({ key: ++this.editKey, ...cue }));
    this.editNote = note;
    this.editorActive = true;
  }

  private clearEditor() {
    this.editorActive = false;
    this.editLines = [];
    this.editCues = [];
  }

  addLine() {
    this.editLines.push({ key: ++this.editKey, role: '', text: '' });
  }

  addCue() {
    this.editCues.push({ key: ++this.editKey, lineageId: null, kind: 'LIGHT', label: '', detail: '' });
  }

  move<T>(list: T[], index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const [item] = list.splice(index, 1);
    list.splice(target, 0, item);
  }

  cancelRevision() {
    this.store.dispatch(rbCancelRevision());
    this.clearEditor();
  }

  confirmRevision() {
    if (!this.confirmName.trim()) return;
    this.store.dispatch(
      rbConfirmRevision({
        note: this.editNote || '导演临时调整',
        lines: this.editLines.map(({ role, text }) => ({ role, text })),
        cues: this.editCues.map(({ lineageId, kind, label, detail }) => ({ lineageId, kind, label, detail })),
        confirmedBy: this.confirmName.trim(),
      }),
    );
    this.clearEditor();
    this.viewVersionSeq = null;
  }

  /* --------------------------------- 设备回执 -------------------------------- */
  sendReceipt(cue: RunCue) {
    const deviceId = `${cue.kind}-01` as DeviceId;
    this.store.dispatch(rbQueueReceipt({ input: { deviceId, cueId: cue.id } }));
  }

  toggleOnline(id: DeviceId) {
    const online = !this.state!.devices[id].online;
    this.store.dispatch(rbSetDeviceOnline({ deviceId: id, online }));
  }

  flush(id: DeviceId) {
    this.store.dispatch(rbFlushDevice({ deviceId: id }));
  }

  resendLast(id: DeviceId) {
    const device = this.state!.devices[id];
    const last = device.receipts[device.receipts.length - 1];
    if (!last) return;
    this.store.dispatch(rbResendReceipt({ deviceId: id, deviceSeq: last.deviceSeq }));
  }

  deviceOnline(kind: CueKind): boolean {
    return this.state?.devices[`${kind}-01` as DeviceId]?.online ?? true;
  }

  /* ---------------------------------- 查询 ---------------------------------- */
  viewing(show: NonNullable<RunbookState['show']>): RunVersion {
    const seq = this.viewVersionSeq ?? show.activeVersionSeq;
    return show.versions.find((version) => version.versionSeq === seq) ?? activeVersion(show);
  }

  viewingVersion(show: NonNullable<RunbookState['show']>): number {
    return this.viewing(show).versionSeq;
  }

  visibleCues(version: RunVersion): RunCue[] {
    return visibleCuesForRole(version, this.viewRole);
  }

  cueBrief(cueId: string): string {
    const show = this.state?.show;
    if (!show) return cueId;
    for (const version of show.versions) {
      const cue = version.cues.find((item) => item.id === cueId);
      if (cue) return `${this.kindLabel(cue.kind)} Q${cue.seq} ${cue.label}`;
    }
    return cueId;
  }

  recent(id: DeviceId) {
    return this.state!.devices[id].receipts.slice(-6).reverse();
  }

  recentLogs() {
    return (this.state?.log ?? []).slice(-40).reverse();
  }

  voidCount(version: RunVersion) {
    return version.cues.filter((cue) => cue.status === 'VOID').length;
  }

  doneCount(version: RunVersion) {
    return version.cues.filter((cue) => cue.status === 'DONE').length;
  }

  deviceRole(id: DeviceId): ConsoleRole {
    return id.slice(0, 5) as ConsoleRole;
  }

  kindLabel(kind: string) { return KIND_LABEL[kind] ?? kind; }
  roleLabel(role: string) { return ROLE_LABEL[role] ?? role; }
  statusLabel(status: string) { return STATUS_LABEL[status] ?? status; }
  outcomeLabel(outcome: string) { return OUTCOME_LABEL[outcome] ?? outcome; }
}
