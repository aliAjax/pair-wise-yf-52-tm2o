import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Store } from '@ngrx/store';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription } from 'rxjs';
import {
  activateVersion,
  addVersion,
  reorderLines,
  reviewCue,
  reviewLine,
  setOnline,
  toggleRehearsal
} from './state/script.actions';
import { ScriptState, ScriptVersion } from './state/script.reducer';
import {
  activateRunning as activateRunningAction,
  applyOrderDraft,
  finishPerformance,
  freezeRunning,
  markCueExecuted,
  setRole,
  setRunningOnline,
  simulateDuplicate,
  uploadNextBatch
} from './state/running.actions';
import {
  createRunningVersion,
  Department,
  Receipt,
  Role,
  RunningCue,
  RunningLine,
  RunningState,
  RunningVersion
} from './state/running.reducer';

interface ReceiptGroup {
  deviceSerial: string;
  department: Department;
  items: Receipt[];
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    DragDropModule,
    MatToolbarModule,
    MatButtonModule,
    MatCardModule,
    MatTabsModule,
    MatChipsModule,
    MatIconModule,
    MatProgressBarModule,
    TranslocoModule
  ],
  template: `
    <mat-toolbar color="primary" class="topbar">
      <span>{{ 'title' | transloco }}</span>
      <span class="spacer"></span>
      <button mat-stroked-button (click)="toggleOnline()">
        {{ ((runningState$ | async)?.online ? 'online' : 'offline') | transloco }}
      </button>
      <button mat-flat-button color="accent" (click)="toggleRehearsal()">
        {{ ((scriptState$ | async)?.rehearsalMode ? 'normalMode' : 'rehearsalMode') | transloco }}
      </button>
    </mat-toolbar>

    <main [class.rehearsal]="(scriptState$ | async)?.rehearsalMode">
      <mat-tab-group [(selectedIndex)]="selectedTab" class="tabs">
        <!-- 剧本版本 -->
        <mat-tab label="剧本版本">
          <section class="summary">
            <mat-card>
              <mat-card-title>版本控制</mat-card-title>
              <p>编剧提交后由舞台监督逐条采纳；冻结成演出运行版后，台词与提示各自带执行顺序。</p>
              <div class="chips">
                <button mat-stroked-button *ngFor="let version of (scriptState$ | async)?.versions"
                  [color]="version.id === (scriptState$ | async)?.activeVersionId ? 'primary' : ''"
                  (click)="activate(version.id)">
                  {{ version.label }} · {{ version.playwright }}
                </button>
                <button mat-flat-button color="primary" (click)="createDraft()">新增导演修订</button>
              </div>
            </mat-card>
          </section>

          <section *ngIf="activeScriptVersion$ | async as activeVersion" class="workspace">
            <mat-card class="script">
              <mat-card-title>{{ activeVersion.label }}</mat-card-title>
              <mat-card-subtitle>{{ activeVersion.note }}</mat-card-subtitle>
              <mat-tab-group>
                <mat-tab label="角色台词">
                  <div cdkDropList (cdkDropListDropped)="dropLine($event)">
                    <article class="line" cdkDrag *ngFor="let line of activeVersion.lines">
                      <div>
                        <b>{{ line.role }}</b>
                        <p>{{ line.text }}</p>
                        <span class="status" [class.ok]="line.status === 'accepted'">{{ line.status }}</span>
                      </div>
                      <div>
                        <button mat-button color="primary" (click)="reviewLine(line.id, 'accepted')">采纳</button>
                        <button mat-button color="warn" (click)="reviewLine(line.id, 'returned')">退回</button>
                      </div>
                    </article>
                  </div>
                </mat-tab>
                <mat-tab label="舞台提示">
                  <article class="line" *ngFor="let cue of activeVersion.cues">
                    <div>
                      <b>{{ cue.scene }}</b>
                      <p>{{ cue.text }}</p>
                      <span class="status" [class.ok]="cue.status === 'accepted'">{{ cue.status }}</span>
                    </div>
                    <div>
                      <button mat-button color="primary" (click)="reviewCue(cue.id, 'accepted')">采纳</button>
                      <button mat-button color="warn" (click)="reviewCue(cue.id, 'returned')">退回</button>
                    </div>
                  </article>
                </mat-tab>
              </mat-tab-group>
            </mat-card>

            <mat-card class="compare">
              <mat-card-title>版本对比</mat-card-title>
              <p class="version-name">基准 v12 → {{ activeVersion.label }}</p>
              <div class="diff"><b>新增</b><span>{{ activeVersion.lines.length }} 条台词 / {{ activeVersion.cues.length }} 条提示</span></div>
              <div class="diff"><b>待确认</b><span>{{ pendingCount(activeVersion) }} 项</span></div>
              <div class="diff warn"><b>冻结</b><span>切到「演出运行版」冻结当前剧本，台词提示各自带执行顺序</span></div>
            </mat-card>
          </section>
        </mat-tab>

        <!-- 演出运行版 -->
        <mat-tab label="演出运行版">
          <ng-container *ngIf="runningState$ | async as rs">
            <section class="summary">
              <mat-card>
                <mat-card-title>演出运行版</mat-card-title>
                <p>把当前剧本冻结成演出运行版：角色台词与舞台提示各自带执行顺序；顺序变化时未执行项作废重算，已执行项保留。</p>
                <div class="chips">
                  <button mat-flat-button color="primary" (click)="freezeCurrent()">冻结当前剧本为演出运行版</button>
                  <button mat-stroked-button *ngFor="let version of rs.versions"
                    [color]="version.id === rs.activeRunningId ? 'primary' : ''"
                    (click)="activateRunning(version.id)">
                    {{ version.label }}
                    <span class="mini" [class.finished]="version.status === 'finished'">
                      {{ version.status === 'running' ? '演出中' : '已结束' }} · #{{ version.orderRevision }}
                    </span>
                  </button>
                </div>
              </mat-card>
            </section>

            <section *ngIf="activeRunning(rs) as rv" class="workspace">
              <mat-card class="script">
                <div class="run-head">
                  <div>
                    <mat-card-title>{{ rv.label }}</mat-card-title>
                    <mat-card-subtitle>
                      顺序版本 <b>#{{ rv.orderRevision }}</b>
                      · {{ rv.status === 'running' ? '演出中' : '演出已结束' }}
                      · 冻结于 {{ rv.frozenAt | date:'MM-dd HH:mm' }}
                    </mat-card-subtitle>
                  </div>
                  <div class="run-actions">
                    <button mat-stroked-button (click)="toggleRole()">
                      当前岗位：{{ roleLabel(rs.role) }}
                    </button>
                    <button mat-stroked-button color="warn" *ngIf="rv.status === 'running' && !changeMode" (click)="startChange(rv)">
                      顺序变更
                    </button>
                    <button mat-flat-button *ngIf="rv.status === 'running'" (click)="finish(rv)">演出结束</button>
                  </div>
                </div>

                <mat-tab-group>
                  <mat-tab label="角色台词（执行顺序）">
                    <div cdkDropList [cdkDropListDisabled]="!changeMode" (cdkDropListDropped)="dropDraftLine($event)">
                      <article class="run-item" cdkDrag [cdkDragDisabled]="line.status === 'executed'" *ngFor="let line of draftLines"
                        [class.voided]="line.status === 'voided'" [class.executed]="line.status === 'executed'">
                        <span class="seq">{{ line.status === 'voided' ? '—' : line.seq }}</span>
                        <div class="run-body">
                          <b>{{ line.role }}</b>
                          <p>{{ line.text }}</p>
                          <span class="exec-meta" *ngIf="line.status === 'executed'">已执行 · 保留原顺序</span>
                          <span class="void-meta" *ngIf="line.status === 'voided'">已作废 · 等待重算</span>
                        </div>
                        <button mat-icon-button color="warn" *ngIf="changeMode && line.status === 'pending'"
                          (click)="voidDraftLine(line.id)" matTooltip="删除并作废">
                          <mat-icon>close</mat-icon>
                        </button>
                      </article>
                    </div>
                  </mat-tab>

                  <mat-tab label="舞台提示（执行顺序）">
                    <div cdkDropList [cdkDropListDisabled]="!changeMode" (cdkDropListDropped)="dropDraftCue($event)">
                      <article class="run-item" cdkDrag [cdkDragDisabled]="cue.status === 'executed'" *ngFor="let cue of draftCues"
                        [class.voided]="cue.status === 'voided'" [class.executed]="cue.status === 'executed'">
                        <span class="seq">{{ cue.status === 'voided' ? '—' : cue.seq }}</span>
                        <div class="run-body">
                          <span class="dept" [attr.data-dept]="cue.department">{{ deptLabel(cue.department) }}</span>
                          <b>{{ cue.scene }}</b>
                          <p>{{ cue.text }}</p>
                          <p class="command" *ngIf="cue.command">
                            灯光口令：
                            <ng-container *ngIf="rs.role === 'stageManager'; else maskedCommand">{{ cue.command }}</ng-container>
                            <ng-template #maskedCommand><span class="masked">••••••（场务不可见）</span></ng-template>
                          </p>
                          <span class="exec-meta" *ngIf="cue.status === 'executed'">
                            已执行 · {{ cue.executedBy }} · {{ cue.executedAt | date:'HH:mm:ss' }} · 保留原顺序
                          </span>
                          <span class="void-meta" *ngIf="cue.status === 'voided'">已作废 · 等待重算</span>
                        </div>
                        <button mat-button color="primary"
                          *ngIf="!changeMode && cue.status === 'pending' && rv.status === 'running'"
                          (click)="executeCue(rv.id, cue.id)">
                          执行回执
                        </button>
                        <button mat-icon-button color="warn" *ngIf="changeMode && cue.status === 'pending'"
                          (click)="voidDraftCue(cue.id)">
                          <mat-icon>close</mat-icon>
                        </button>
                      </article>
                    </div>
                  </mat-tab>
                </mat-tab-group>

                <div class="change-bar" *ngIf="changeMode">
                  <span>顺序变更模式：删除未执行项或拖动排序；确认后未执行项作废重算，已执行项保留。</span>
                  <span class="spacer"></span>
                  <button mat-flat-button color="primary" (click)="confirmChange()">确认变更（作废重算）</button>
                  <button mat-button (click)="cancelChange()">取消</button>
                </div>
              </mat-card>

              <mat-card class="compare">
                <mat-card-title>同步状态</mat-card-title>
                <div class="diff"><b>网络</b><span [class.ok-text]="rs.online">{{ rs.online ? '在线' : '离线' }}</span></div>
                <div class="diff"><b>待上传回执</b><span>{{ rs.pendingQueue.length }} 条</span></div>
                <div class="diff"><b>断点位置</b><span>{{ rs.uploadCursor }} / {{ rs.pendingQueue.length }}</span></div>
                <div class="diff"><b>已合并回执</b><span>{{ rs.receipts.length }} 条（按设备序号对齐）</span></div>
                <div class="diff warn"><b>迟到回执</b><span>{{ lateCount(rs) }} 条（不盖新顺序）</span></div>
                <button mat-stroked-button color="primary" (click)="selectedTab = 2">前往回执同步 →</button>
              </mat-card>
            </section>
          </ng-container>
        </mat-tab>

        <!-- 回执同步 -->
        <mat-tab label="回执同步">
          <ng-container *ngIf="runningState$ | async as rs">
            <section class="workspace">
              <mat-card class="script">
                <mat-card-title>离线回执与断点续传</mat-card-title>
                <mat-card-subtitle>灯光、音效、场务离线回执按设备序号合并；重复回执只算一次；恢复网络后从断点继续上传。</mat-card-subtitle>
                <div class="sync-grid">
                  <div class="diff"><b>本机设备序号</b><span>{{ rs.deviceSerial }}</span></div>
                  <div class="diff"><b>网络</b><span [class.ok-text]="rs.online">{{ rs.online ? '在线' : '离线' }}</span></div>
                  <div class="diff"><b>待上传</b><span>{{ rs.pendingQueue.length }} 条</span></div>
                  <div class="diff"><b>断点位置</b><span>{{ rs.uploadCursor }} / {{ rs.pendingQueue.length }}</span></div>
                </div>
                <mat-progress-bar class="progress" mode="determinate"
                  [value]="rs.pendingQueue.length ? (rs.uploadCursor / rs.pendingQueue.length) * 100 : 0">
                </mat-progress-bar>
                <div class="chips">
                  <button mat-flat-button color="primary" [disabled]="!rs.online || rs.pendingQueue.length === 0"
                    (click)="uploadNextBatch()">
                    上传下一批（断点续传）
                  </button>
                  <button mat-stroked-button (click)="goOffline()">模拟断网</button>
                  <button mat-stroked-button (click)="goOnline()">恢复网络</button>
                  <button mat-stroked-button (click)="simulateDuplicate()">模拟重复回执上传</button>
                </div>
                <p class="dup-note">重复回执已忽略：<b>{{ rs.duplicatesIgnored }}</b> 条（同一设备序号下重复回执只算一次）</p>
              </mat-card>

              <mat-card class="compare">
                <mat-card-title>已合并回执（按设备序号对齐）</mat-card-title>
                <div *ngFor="let group of groupedReceipts(rs.receipts)" class="receipt-group">
                  <h4>{{ group.deviceSerial }} · {{ deptLabel(group.department) }}</h4>
                  <div *ngFor="let receipt of group.items" class="receipt" [class.late]="receipt.late">
                    <span class="seq">#{{ receipt.seq ?? '—' }}</span>
                    <span class="receipt-time">{{ receipt.timestamp | date:'HH:mm:ss' }}</span>
                    <span class="receipt-rev">顺序 #{{ receipt.orderRevision }}</span>
                    <span class="receipt-target">{{ deptLabel(receipt.department) }} · {{ receipt.targetId }}</span>
                    <span class="badge-late" *ngIf="receipt.late">迟到回执 · 未盖到新顺序</span>
                    <span class="badge-ok" *ngIf="!receipt.late">已生效</span>
                  </div>
                </div>
              </mat-card>
            </section>
          </ng-container>
        </mat-tab>

        <!-- 执行记录 -->
        <mat-tab label="执行记录">
          <ng-container *ngIf="runningState$ | async as rs">
            <section class="workspace archive">
              <mat-card class="script" *ngFor="let version of rs.versions">
                <mat-card-title>
                  {{ version.label }}
                  <span class="mini" [class.finished]="version.status === 'finished'">
                    {{ version.status === 'running' ? '演出中' : '已结束' }} · 顺序 #{{ version.orderRevision }}
                  </span>
                </mat-card-title>
                <mat-card-subtitle>冻结于 {{ version.frozenAt | date:'yyyy-MM-dd HH:mm' }}</mat-card-subtitle>

                <h4>已执行（{{ executedCues(version).length }}）</h4>
                <div *ngIf="executedCues(version).length === 0" class="empty">暂无执行记录</div>
                <div class="receipt" *ngFor="let cue of executedCues(version)">
                  <span class="seq">#{{ cue.seq }}</span>
                  <span class="dept" [attr.data-dept]="cue.department">{{ deptLabel(cue.department) }}</span>
                  <span>{{ cue.text }}</span>
                  <span class="receipt-time">{{ cue.executedAt | date:'MM-dd HH:mm:ss' }}</span>
                  <span class="receipt-target">{{ cue.executedBy }}</span>
                </div>

                <h4>已作废（{{ voidedCues(version).length }}）</h4>
                <div *ngIf="voidedCues(version).length === 0" class="empty">无</div>
                <div class="receipt void" *ngFor="let cue of voidedCues(version)">
                  <span class="seq">—</span>
                  <span>{{ cue.text }}</span>
                  <span class="badge-late">顺序变更时作废重算</span>
                </div>

                <h4>回执（{{ receiptsFor(rs, version.id).length }}）</h4>
                <div *ngFor="let receipt of receiptsFor(rs, version.id)" class="receipt" [class.late]="receipt.late">
                  <span class="seq">#{{ receipt.seq ?? '—' }}</span>
                  <span class="receipt-time">{{ receipt.timestamp | date:'MM-dd HH:mm:ss' }}</span>
                  <span class="receipt-rev">顺序 #{{ receipt.orderRevision }}</span>
                  <span class="receipt-target">{{ receipt.deviceSerial }}</span>
                  <span class="badge-late" *ngIf="receipt.late">迟到 · 未盖到新顺序</span>
                  <span class="badge-ok" *ngIf="!receipt.late">已生效</span>
                </div>
              </mat-card>
            </section>
          </ng-container>
        </mat-tab>
      </mat-tab-group>

      <aside class="offline" *ngIf="(runningState$ | async)?.online === false">
        网络不可用：执行回执已写入本机待上传队列，恢复网络后从断点继续上传，迟到回执不会盖到新顺序。
      </aside>
    </main>
  `,
  styles: [`
    .topbar { position: sticky; top: 0; z-index: 4; }
    .spacer { flex: 1; }
    main { max-width: 1180px; margin: 24px auto; padding: 0 18px 48px; }
    main.rehearsal { max-width: 860px; background: #111827; color: #f9fafb; margin-top: 0; }
    main.rehearsal .script, main.rehearsal .compare, main.rehearsal .summary { opacity: .92; }
    .tabs { margin-top: 4px; }
    .summary { margin-bottom: 18px; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; align-items: center; }
    .mini { font-size: 12px; color: #b45309; margin-left: 6px; }
    .mini.finished { color: #15803d; }
    .workspace { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 18px; }
    .archive { grid-template-columns: 1fr; }
    .line { cursor: grab; display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 0; border-bottom: 1px solid #e5e7eb; }
    .line p { margin: 8px 0; font-size: 17px; line-height: 1.6; }
    .status { font-size: 12px; color: #b45309; }
    .status.ok { color: #15803d; }
    .version-name { padding: 12px; background: #f3f4f6; border-radius: 8px; }
    .diff { display: flex; justify-content: space-between; border-bottom: 1px solid #e5e7eb; padding: 14px 0; gap: 12px; }
    .diff.warn b { color: #b45309; }
    .ok-text { color: #15803d; font-weight: 600; }
    .offline { position: fixed; right: 18px; bottom: 18px; padding: 14px 18px; color: #fff; background: #b45309; border-radius: 10px; box-shadow: 0 8px 30px #0003; max-width: 360px; }

    .run-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
    .run-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .run-item { display: flex; align-items: flex-start; gap: 12px; padding: 14px 0; border-bottom: 1px solid #e5e7eb; }
    .run-item.executed { background: #f0fdf4; }
    .run-item.voided { opacity: .55; }
    .run-item.voided .run-body p { text-decoration: line-through; }
    .seq { flex: 0 0 34px; height: 34px; border-radius: 50%; background: #eef2ff; color: #3730a3; font-weight: 700; display: flex; align-items: center; justify-content: center; font-size: 14px; }
    .run-item.executed .seq { background: #dcfce7; color: #166534; }
    .run-item.voided .seq { background: #f3f4f6; color: #6b7280; }
    .run-body { flex: 1; min-width: 0; }
    .run-body p { margin: 6px 0; font-size: 16px; line-height: 1.6; }
    .dept { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px; color: #fff; margin-right: 6px; }
    .dept[data-dept="lighting"] { background: #b45309; }
    .dept[data-dept="sound"] { background: #1d4ed8; }
    .dept[data-dept="stage"] { background: #6b7280; }
    .command { font-size: 13px; color: #6b7280; }
    .masked { color: #9ca3af; letter-spacing: 2px; }
    .exec-meta { font-size: 12px; color: #15803d; }
    .void-meta { font-size: 12px; color: #6b7280; }
    .change-bar { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding: 12px 14px; background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; font-size: 13px; }

    .sync-grid { margin: 10px 0; }
    .progress { margin: 8px 0 16px; }
    .dup-note { margin-top: 14px; font-size: 13px; color: #6b7280; }
    .receipt-group { margin-bottom: 16px; }
    .receipt-group h4 { margin: 8px 0; font-size: 13px; color: #374151; }
    .receipt { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #f3f4f6; font-size: 13px; flex-wrap: wrap; }
    .receipt.late { background: #fffbeb; }
    .receipt.void { opacity: .7; }
    .receipt-time { color: #6b7280; font-variant-numeric: tabular-nums; }
    .receipt-rev { color: #3730a3; }
    .receipt-target { color: #6b7280; }
    .badge-late { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #fef3c7; color: #92400e; }
    .badge-ok { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #dcfce7; color: #166534; }
    .empty { font-size: 13px; color: #9ca3af; padding: 6px 0; }
    h4 { margin: 16px 0 4px; }
    @media (max-width: 820px) { .workspace { grid-template-columns: 1fr; } }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  readonly scriptState$ = this.store.select('script');
  readonly runningState$ = this.store.select('running');
  readonly activeScriptVersion$ = this.store.select((state) => {
    const script = state.script as ScriptState;
    return script.versions.find((item) => item.id === script.activeVersionId) ?? script.versions[0];
  });

  selectedTab = 0;
  changeMode = false;
  draftLines: RunningLine[] = [];
  draftCues: RunningCue[] = [];
  private draftRunningId: string | null = null;
  private scriptSnapshot: ScriptState | null = null;
  private runningSnapshot: RunningState | null = null;
  private subscriptions: Subscription[] = [];

  constructor(private readonly store: Store<{ script: ScriptState; running: RunningState }>) {}

  ngOnInit() {
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    this.subscriptions.push(
      this.scriptState$.subscribe((state) => {
        this.scriptSnapshot = state;
        localStorage.setItem('yf52-script-state', JSON.stringify(state));
      }),
      this.runningState$.subscribe((state) => {
        this.runningSnapshot = state;
        localStorage.setItem('yf52-running-state', JSON.stringify(state));
      })
    );
  }

  ngOnDestroy() {
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.subscriptions.forEach((sub) => sub.unsubscribe());
  }

  private onlineHandler = () => this.setOnline(true);
  private offlineHandler = () => this.setOnline(false);

  // ---- 剧本版本 ----
  activate(id: string) {
    this.store.dispatch(activateVersion({ id }));
  }
  toggleRehearsal() {
    this.store.dispatch(toggleRehearsal());
  }
  reviewLine(id: string, decision: 'accepted' | 'returned') {
    this.store.dispatch(reviewLine({ id, decision }));
  }
  reviewCue(id: string, decision: 'accepted' | 'returned') {
    this.store.dispatch(reviewCue({ id, decision }));
  }
  dropLine(event: CdkDragDrop<unknown>) {
    if (event.previousIndex !== event.currentIndex) {
      this.store.dispatch(reorderLines({ from: event.previousIndex, to: event.currentIndex }));
    }
  }
  pendingCount(version: ScriptVersion) {
    return version.lines.filter((item) => item.status === 'pending').length
      + version.cues.filter((item) => item.status === 'pending').length;
  }
  createDraft() {
    const id = `v${Date.now().toString().slice(-4)}`;
    const version: ScriptVersion = {
      id,
      label: `导演修订 ${id}`,
      playwright: '本地草稿',
      note: '断网期间创建的修订，等待与编剧版本合并。',
      lines: [{ id: `${id}-l1`, role: '周岚', text: '这次换你告诉我，灯亮之后准备去哪里。', status: 'pending' }],
      cues: [{ id: `${id}-c1`, scene: '第三场', text: '追光保持到台词结束，再执行全场收光', status: 'pending' }]
    };
    this.store.dispatch(addVersion({ version }));
    this.store.dispatch(activateVersion({ id }));
  }

  // ---- 演出运行版 ----
  activeRunning(rs: RunningState): RunningVersion {
    return rs.versions.find((item) => item.id === rs.activeRunningId) ?? rs.versions[0];
  }
  activateRunning(id: string) {
    this.changeMode = false;
    this.store.dispatch(activateRunningAction({ id }));
  }
  freezeCurrent() {
    if (!this.scriptSnapshot) return;
    const script = this.scriptSnapshot;
    const source = script.versions.find((item) => item.id === script.activeVersionId) ?? script.versions[0];
    const version = createRunningVersion(source, Date.now());
    this.store.dispatch(freezeRunning({ version }));
    this.changeMode = false;
    this.selectedTab = 1;
  }
  startChange(version: RunningVersion) {
    this.draftRunningId = version.id;
    this.draftLines = version.lines.map((line) => ({ ...line }));
    this.draftCues = version.cues.map((cue) => ({ ...cue }));
    this.changeMode = true;
  }
  cancelChange() {
    this.changeMode = false;
    this.draftRunningId = null;
  }
  voidDraftLine(id: string) {
    this.draftLines = this.draftLines.map((line) => (line.id === id ? { ...line, status: 'voided' as const } : line));
  }
  voidDraftCue(id: string) {
    this.draftCues = this.draftCues.map((cue) => (cue.id === id ? { ...cue, status: 'voided' as const } : cue));
  }
  dropDraftLine(event: CdkDragDrop<unknown>) {
    moveItemInArray(this.draftLines, event.previousIndex, event.currentIndex);
  }
  dropDraftCue(event: CdkDragDrop<unknown>) {
    moveItemInArray(this.draftCues, event.previousIndex, event.currentIndex);
  }
  confirmChange() {
    if (!this.draftRunningId) return;
    this.store.dispatch(applyOrderDraft({ runningId: this.draftRunningId, lines: this.draftLines, cues: this.draftCues }));
    this.changeMode = false;
    this.draftRunningId = null;
  }
  executeCue(runningId: string, cueId: string) {
    this.store.dispatch(markCueExecuted({ runningId, cueId }));
  }
  finish(version: RunningVersion) {
    this.store.dispatch(finishPerformance({ runningId: version.id }));
  }
  toggleRole() {
    const role = this.runningSnapshot?.role === 'stageManager' ? 'stageCrew' : 'stageManager';
    this.store.dispatch(setRole({ role }));
  }

  // ---- 网络与回执 ----
  setOnline(online: boolean) {
    this.store.dispatch(setOnline({ online }));
    this.store.dispatch(setRunningOnline({ online }));
  }
  toggleOnline() {
    const next = !this.scriptSnapshot?.online;
    this.setOnline(next);
  }
  goOffline() {
    this.setOnline(false);
  }
  goOnline() {
    this.setOnline(true);
  }
  uploadNextBatch() {
    this.store.dispatch(uploadNextBatch());
  }
  simulateDuplicate() {
    this.store.dispatch(simulateDuplicate());
  }

  // ---- 展示工具 ----
  roleLabel(role: Role): string {
    return role === 'stageManager' ? '舞台监督' : '场务';
  }
  deptLabel(department: Department): string {
    return department === 'lighting' ? '灯光' : department === 'sound' ? '音效' : '场务';
  }
  lateCount(rs: RunningState): number {
    return rs.receipts.filter((receipt) => receipt.late).length;
  }
  groupedReceipts(receipts: Receipt[]): ReceiptGroup[] {
    const map = new Map<string, ReceiptGroup>();
    for (const receipt of receipts) {
      let group = map.get(receipt.deviceSerial);
      if (!group) {
        group = { deviceSerial: receipt.deviceSerial, department: receipt.department, items: [] };
        map.set(receipt.deviceSerial, group);
      }
      group.items.push(receipt);
    }
    return Array.from(map.values()).sort((a, b) => a.deviceSerial.localeCompare(b.deviceSerial));
  }
  receiptsFor(rs: RunningState, runningId: string): Receipt[] {
    return rs.receipts.filter((receipt) => receipt.runningId === runningId);
  }
  executedCues(version: RunningVersion): RunningCue[] {
    return version.cues.filter((cue) => cue.status === 'executed');
  }
  voidedCues(version: RunningVersion): RunningCue[] {
    return version.cues.filter((cue) => cue.status === 'voided');
  }
}
