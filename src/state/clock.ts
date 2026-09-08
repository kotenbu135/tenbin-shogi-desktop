// 対局時計。持ち時間（分）と秒読み（秒）。日本の対局と同じく、持ち時間を使い切ったら
// 1手ごとに秒読みの秒数以内で指す。消費時間は手ごとに秒単位（切り捨て）で棋譜に残す。

import type { Color } from './game.ts';

export interface TimeControl {
  /** 持ち時間（秒）。0 なら秒読みだけ */
  mainSec: number;
  /** 秒読み（秒）。0 なら無し */
  byoyomiSec: number;
}

export interface MoveTime {
  /** この手に使った秒 */
  elapsed: number;
  /** その対局者の累計秒 */
  total: number;
}

export interface ClockView {
  /** 残りの持ち時間 "hh:mm:ss" */
  main: string;
  /** 秒読み中なら残り秒 */
  byoyomi: number | null;
  /** 秒読みに入っているか */
  inByoyomi: boolean;
  running: boolean;
}

function hms(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export class Clock {
  private remainingMs: Record<Color, number>;
  private totalSec: Record<Color, number> = { sente: 0, gote: 0 };
  private running: Color | null = null;
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  onTick: (() => void) | null = null;
  onTimeout: ((loser: Color) => void) | null = null;

  constructor(readonly control: TimeControl | null) {
    const m = (control?.mainSec ?? 0) * 1000;
    this.remainingMs = { sente: m, gote: m };
  }

  get enabled(): boolean {
    return this.control !== null && (this.control.mainSec > 0 || this.control.byoyomiSec > 0);
  }

  /** 手番の側の時計を動かす。 */
  start(color: Color): void {
    this.stopTimer();
    this.running = color;
    this.startedAt = performance.now();
    if (!this.enabled) return;
    this.timer = setInterval(() => this.tick(), 200);
  }

  private elapsedMs(): number {
    return this.running ? performance.now() - this.startedAt : 0;
  }

  private tick(): void {
    const c = this.running;
    if (!c || !this.control) return;
    const used = this.elapsedMs();
    const main = this.remainingMs[c];
    const over = used - main; // 持ち時間を超えたぶん
    if (over > 0 && over > this.control.byoyomiSec * 1000) {
      const loser = c;
      this.stopTimer();
      this.running = null;
      this.remainingMs[c] = 0;
      this.onTimeout?.(loser);
      return;
    }
    this.onTick?.();
  }

  /** 手が指されたときに呼ぶ。この手の消費時間を返し、次の手番へ切り替える。 */
  press(next: Color): MoveTime | undefined {
    const c = this.running;
    if (!c || !this.enabled) {
      // 時間を計らない対局では消費時間を残さない
      this.start(next);
      return undefined;
    }
    const usedMs = this.elapsedMs();
    const elapsed = Math.floor(usedMs / 1000);
    if (this.control) {
      // 持ち時間から引く。秒読み中に指した分は持ち時間を減らさない（0 のまま）
      this.remainingMs[c] = Math.max(0, this.remainingMs[c] - usedMs);
    }
    this.totalSec[c] += elapsed;
    const t = { elapsed, total: this.totalSec[c] };
    this.start(next);
    return t;
  }

  /** 対局が終わったら止める。 */
  stop(): void {
    this.stopTimer();
    this.running = null;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  view(color: Color): ClockView | null {
    if (!this.enabled || !this.control) return null;
    const running = this.running === color;
    const used = running ? this.elapsedMs() : 0;
    const mainLeft = this.remainingMs[color] - used;
    if (mainLeft > 0) {
      return { main: hms(mainLeft / 1000), byoyomi: null, inByoyomi: false, running };
    }
    const byoLeft = this.control.byoyomiSec - Math.floor(Math.max(0, -mainLeft) / 1000);
    return {
      main: hms(0),
      byoyomi: this.control.byoyomiSec > 0 ? Math.max(0, byoLeft) : null,
      inByoyomi: true,
      running,
    };
  }
}

/** KIF の「持ち時間：00:10+30」の書式 */
export function formatTimeControl(tc: TimeControl | null): string {
  if (!tc || (tc.mainSec === 0 && tc.byoyomiSec === 0)) return '';
  const h = Math.floor(tc.mainSec / 3600);
  const m = Math.floor((tc.mainSec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}+${String(tc.byoyomiSec).padStart(2, '0')}`;
}

export function parseTimeControl(s: string): TimeControl | null {
  // KIF の正規化で ':' が '：' になっていることがある
  const m = /^(\d+):(\d+)(?:\+(\d+))?/.exec(s.trim().replace(/：/g, ':'));
  if (!m) return null;
  return { mainSec: Number(m[1]) * 3600 + Number(m[2]) * 60, byoyomiSec: Number(m[3] ?? 0) };
}
