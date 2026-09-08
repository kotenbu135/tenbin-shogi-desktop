// USI エンジン1本の状態機械。プロセスの起動と行の往復は Tauri（Rust の usi-host）が担い、
// ここは語彙の解釈と「go を重ねない」規律を持つ。
//
// 1つのエンジンに go を重ねてはいけない。重ねると bestmove の待ち合わせが交差して、
// 検討の待ち手に対局の指し手が返る（またはその逆）。落ちずに、盤に入る手だけが入れ替わる。

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { parseBestmove, parseId, parseInfo, parseOption, type Bestmove, type UsiInfo, type UsiOption } from './parse.ts';
import { DEFAULT_EVAL, type EvalScale } from './evalscale.ts';

export type EngineKind = 'normal' | 'fuseki';

export interface EngineConfig {
  id: string;
  name: string;
  /** 実行ファイル */
  path: string;
  /** 起動時の引数（空白区切り）。wsl.exe 経由で Linux 側のエンジンを起動するときなどに使う */
  args?: string;
  /** 省略時は実行ファイルのフォルダ */
  cwd?: string;
  /** normal: 41手目以降だけ。fuseki: 布石 USI 拡張（position fuseki）を受ける */
  kind: EngineKind;
  /**
   * setoption の上書き。name → value。Threads・USI_Hash・MultiPV・EvalDir も普通の項目としてここに入る。
   * エンジンが申告した既定値と同じものは持たない。
   */
  options: Record<string, string>;
  /** 登録時に `usi` で読んだ申告。設定画面を組み立てるのに使う */
  declared?: UsiOption[];
  idName?: string;
  idAuthor?: string;
  /** cp → 勝率の目盛り（エンジンごと） */
  eval: EvalScale;
}

export function newEngineConfig(): EngineConfig {
  return {
    id: 'e' + Math.random().toString(36).slice(2, 10),
    name: '',
    path: '',
    kind: 'normal',
    options: {},
    eval: { ...DEFAULT_EVAL },
  };
}

/** よく触る項目は先頭に出す。残りは申告順 */
export const COMMON_OPTIONS = ['Threads', 'USI_Hash', 'MultiPV', 'EvalDir', 'BookFile', 'USI_OwnBook', 'FV_SCALE', 'NetworkDelay', 'NetworkDelay2'];

export function optionValue(cfg: EngineConfig, name: string): string | undefined {
  if (cfg.options[name] !== undefined) return cfg.options[name];
  return cfg.declared?.find((o) => o.name === name)?.default;
}

interface EnginePayload {
  kind: 'line' | 'stderr' | 'exit';
  id: string;
  line?: string;
  code?: number | null;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// 全エンジン共通のイベント受信。id で振り分ける。
const receivers = new Map<string, (p: EnginePayload) => void>();
let listening: Promise<void> | null = null;
function ensureListener(): Promise<void> {
  if (!listening) {
    listening = listen<EnginePayload>('engine-event', (e) => {
      receivers.get(e.payload.id)?.(e.payload);
    }).then(() => undefined);
  }
  return listening;
}

export type EngineState = 'stopped' | 'starting' | 'ready' | 'thinking';
export type LogDirection = 'in' | 'out' | 'err' | 'sys';

interface Waiter {
  match: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 検討・対局が相手にする「思考するもの」。USI のプロセスも、内蔵の布石評価も、この形で見える。
 */
export interface Thinker {
  readonly config: EngineConfig;
  state: EngineState;
  idName: string;
  onLog: ((dir: LogDirection, text: string) => void) | null;
  onStateChange: ((s: EngineState) => void) | null;
  start(): Promise<void>;
  /** `position …` を渡して考えさせる。info は onInfo へ。止めるのは stop() */
  goInfinite(positionCmd: string, onInfo: (info: UsiInfo) => void): Promise<void>;
  /** 1手指す。goArgs は "btime 60000 wtime 60000 byoyomi 10000" や "movetime 3000" */
  go(positionCmd: string, goArgs: string, onInfo?: (info: UsiInfo) => void): Promise<Bestmove>;
  stop(): Promise<void>;
  quit(): Promise<void>;
  send(line: string): void;
  newGame(): Promise<void>;
  /** MultiPV など、走っていないときに送る 1 項目 */
  setOption(name: string, value: string | number): void;
  hasOption(name: string): boolean;
}

export class UsiEngine implements Thinker {
  state: EngineState = 'stopped';
  idName = '';
  idAuthor = '';
  options: UsiOption[] = [];
  onLog: ((dir: LogDirection, text: string) => void) | null = null;
  onStateChange: ((s: EngineState) => void) | null = null;
  private waiters: Waiter[] = [];
  private onInfo: ((info: UsiInfo) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** プロセスの識別子。同じ登録を2本立てる（対局の先後）ときは別にする */
  readonly processId: string;
  readonly config: EngineConfig;

  constructor(config: EngineConfig, processId?: string) {
    this.config = config;
    this.processId = processId ?? config.id;
  }

  private setState(s: EngineState): void {
    this.state = s;
    this.onStateChange?.(s);
  }

  private log(dir: LogDirection, text: string): void {
    this.onLog?.(dir, text);
  }

  /** 起動して usiok → 設定 → readyok まで進める。 */
  async start(): Promise<void> {
    if (!isTauri()) throw new Error('エンジンの起動は Tauri のアプリ内でだけできる（ブラウザのプレビューでは不可）');
    if (this.state !== 'stopped') return;
    this.setState('starting');
    try {
      await this.spawn();
      this.send('usi');
      await this.waitFor((l) => l === 'usiok', 15000);
      this.applyOptions();
      this.send('isready');
      await this.waitFor((l) => l === 'readyok', 120000);
      this.setState('ready');
    } catch (e) {
      await this.quit();
      throw e;
    }
  }

  private async spawn(): Promise<void> {
    await ensureListener();
    receivers.set(this.processId, (p) => this.receive(p));
    await invoke('engine_start', {
      id: this.processId,
      path: this.config.path,
      args: (this.config.args ?? '').split(/\s+/).filter(Boolean),
      cwd: this.config.cwd || null,
    });
    this.log('sys', `起動: ${this.config.path}`);
    this.options = [];
  }

  /** 上書きの setoption を送る。申告に無い名前も送る（エンジンが読み捨てる） */
  private applyOptions(): void {
    const declared = new Map(this.options.map((o) => [o.name, o]));
    for (const [k, v] of Object.entries(this.config.options)) {
      if (!k) continue;
      const d = declared.get(k);
      if (d && d.default !== undefined && d.default === v) continue;
      if (d?.type === 'button') continue;
      this.send(`setoption name ${k} value ${v}`);
    }
  }

  setOption(name: string, value: string | number): void {
    if (this.state === 'stopped' || this.state === 'starting') return;
    this.send(`setoption name ${name} value ${value}`);
  }

  hasOption(name: string): boolean {
    return this.options.some((o) => o.name === name);
  }

  private receive(p: EnginePayload): void {
    if (p.kind === 'exit') {
      this.log('sys', '終了した');
      this.failWaiters(new Error('エンジンが終了した'));
      receivers.delete(this.processId);
      this.setState('stopped');
      return;
    }
    const line = (p.line ?? '').replace(/\r$/, '');
    if (p.kind === 'stderr') {
      this.log('err', line);
      return;
    }
    this.log('in', line);
    const id = parseId(line);
    if (id?.name) this.idName = id.name;
    if (id?.author) this.idAuthor = id.author;
    const opt = parseOption(line);
    if (opt) this.options.push(opt);
    if (line.startsWith('info')) {
      const info = parseInfo(line);
      if (info && (info.scoreCp !== undefined || info.scoreMate !== undefined || info.winrate !== undefined || info.string !== undefined)) {
        this.onInfo?.(info);
      }
    }
    for (const w of this.waiters.slice()) {
      if (w.match(line)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(line);
      }
    }
  }

  private failWaiters(e: Error): void {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(e);
    }
  }

  private waitFor(match: (line: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(new Error(`エンジンが ${timeoutMs / 1000} 秒応答しない`));
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  send(line: string): void {
    this.log('out', line);
    void invoke('engine_send', { id: this.processId, line }).catch((e) => this.log('sys', String(e)));
  }

  async newGame(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'starting') return;
    await this.stop();
    this.send('usinewgame');
  }

  /**
   * 検討を始める。既に走っていれば止めてから始める。
   * `positionCmd` は "position sfen ..." または "position fuseki moves ..." の完全な行。
   */
  async goInfinite(positionCmd: string, onInfo: (info: UsiInfo) => void): Promise<void> {
    if (this.state === 'stopped' || this.state === 'starting') throw new Error('エンジンが準備できていない');
    await this.stop();
    this.onInfo = onInfo;
    this.setState('thinking');
    this.send(positionCmd);
    this.send('go infinite');
  }

  /** 1手指させて bestmove を待つ。途中で stop() されたときも、そのとき返った bestmove で解決する。 */
  async go(positionCmd: string, goArgs: string, onInfo?: (info: UsiInfo) => void): Promise<Bestmove> {
    if (this.state === 'stopped' || this.state === 'starting') throw new Error('エンジンが準備できていない');
    await this.stop();
    this.onInfo = onInfo ?? null;
    this.setState('thinking');
    const p = this.waitFor((l) => l.startsWith('bestmove'), 3_600_000);
    this.send(positionCmd);
    this.send(`go ${goArgs}`.trim());
    try {
      const line = await p;
      const bm = parseBestmove(line);
      if (!bm) throw new Error(`bestmove を読めない: ${line}`);
      return bm;
    } finally {
      this.onInfo = null;
      if (this.state === 'thinking') this.setState('ready');
    }
  }

  /** 走っている探索を止め、bestmove を待つ。走っていなければ何もしない。 */
  async stop(): Promise<void> {
    if (this.state !== 'thinking') return;
    this.onInfo = null;
    const run = async () => {
      if (this.state !== 'thinking') return;
      const p = this.waitFor((l) => l.startsWith('bestmove'), 10000);
      this.send('stop');
      try {
        await p;
      } catch {
        // 応答しないエンジンは次の go で上書きされる。ここで落とさない。
      }
      if (this.state === 'thinking') this.setState('ready');
    };
    const next = this.chain.then(run, run);
    this.chain = next.then(() => undefined, () => undefined);
    await next;
  }

  async quit(): Promise<void> {
    this.onInfo = null;
    receivers.delete(this.processId);
    this.failWaiters(new Error('エンジンを止めた'));
    if (isTauri()) {
      try {
        await invoke('engine_stop', { id: this.processId });
      } catch (e) {
        this.log('sys', String(e));
      }
    }
    this.setState('stopped');
  }

  /**
   * 登録のための下見。起動して `usi` を送り、名前と申告を読んで止める。
   * isready は送らない（評価関数の読み込みで長く待つエンジンがある）。
   */
  static async probe(cfg: Pick<EngineConfig, 'path' | 'args' | 'cwd'>, onLog?: (dir: LogDirection, text: string) => void): Promise<{ idName: string; idAuthor: string; options: UsiOption[] }> {
    const tmp = new UsiEngine({ ...newEngineConfig(), ...cfg }, 'probe-' + Math.random().toString(36).slice(2, 8));
    tmp.onLog = onLog ?? null;
    tmp.setState('starting');
    try {
      await tmp.spawn();
      tmp.send('usi');
      await tmp.waitFor((l) => l === 'usiok', 15000);
      return { idName: tmp.idName, idAuthor: tmp.idAuthor, options: tmp.options.slice() };
    } finally {
      tmp.send('quit');
      await tmp.quit();
    }
  }
}
