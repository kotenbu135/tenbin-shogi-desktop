// USI エンジン1本の状態機械。プロセスの起動と行の往復は Tauri（Rust の usi-host）が担い、
// ここは語彙の解釈と「go を重ねない」規律を持つ。
//
// 1つのエンジンに go を重ねてはいけない。重ねると bestmove の待ち合わせが交差して、
// 検討の待ち手に対局の指し手が返る（またはその逆）。落ちずに、盤に入る手だけが入れ替わる。

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { parseBestmove, parseId, parseInfo, parseOption, type UsiInfo, type UsiOption } from './parse.ts';

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
  /** やねうら王の EvalDir。各自が用意する（同梱しない） */
  evalDir?: string;
  threads: number;
  hashMb: number;
  multiPv: number;
  /** normal: 41手目以降だけ。fuseki: 布石 USI 拡張（position fuseki）を受ける */
  kind: EngineKind;
  /** 追加の setoption。name → value */
  options: Record<string, string>;
}

export function newEngineConfig(): EngineConfig {
  return {
    id: 'e' + Math.random().toString(36).slice(2, 10),
    name: '',
    path: '',
    threads: 4,
    hashMb: 256,
    multiPv: 3,
    kind: 'normal',
    options: {},
  };
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

export class UsiEngine {
  state: EngineState = 'stopped';
  idName = '';
  options: UsiOption[] = [];
  onLog: ((dir: LogDirection, text: string) => void) | null = null;
  onStateChange: ((s: EngineState) => void) | null = null;
  private waiters: Waiter[] = [];
  private onInfo: ((info: UsiInfo) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(public readonly config: EngineConfig) {}

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
    await ensureListener();
    receivers.set(this.config.id, (p) => this.receive(p));
    try {
      await invoke('engine_start', {
        id: this.config.id,
        path: this.config.path,
        args: (this.config.args ?? '').split(/\s+/).filter(Boolean),
        cwd: this.config.cwd || null,
      });
      this.log('sys', `起動: ${this.config.path}`);
      this.options = [];
      this.send('usi');
      await this.waitFor((l) => l === 'usiok', 15000);
      const c = this.config;
      const known = new Set(this.options.map((o) => o.name));
      const setIf = (name: string, value: string | number | undefined) => {
        if (value === undefined || value === '') return;
        if (!known.has(name)) return;
        this.send(`setoption name ${name} value ${value}`);
      };
      setIf('USI_Hash', c.hashMb);
      setIf('Threads', c.threads);
      setIf('MultiPV', c.multiPv);
      setIf('EvalDir', c.evalDir);
      for (const [k, v] of Object.entries(c.options)) {
        if (k) this.send(`setoption name ${k} value ${v}`);
      }
      this.send('isready');
      await this.waitFor((l) => l === 'readyok', 120000);
      this.setState('ready');
    } catch (e) {
      await this.quit();
      throw e;
    }
  }

  private receive(p: EnginePayload): void {
    if (p.kind === 'exit') {
      this.log('sys', '終了した');
      this.failWaiters(new Error('エンジンが終了した'));
      receivers.delete(this.config.id);
      this.setState('stopped');
      return;
    }
    const line = p.line ?? '';
    if (p.kind === 'stderr') {
      this.log('err', line);
      return;
    }
    this.log('in', line);
    const id = parseId(line);
    if (id?.name) this.idName = id.name;
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
    void invoke('engine_send', { id: this.config.id, line }).catch((e) => this.log('sys', String(e)));
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

  /** 走っている探索を止め、bestmove を待つ。走っていなければ何もしない。 */
  async stop(): Promise<void> {
    if (this.state !== 'thinking') return;
    this.onInfo = null;
    const run = async () => {
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
    receivers.delete(this.config.id);
    this.failWaiters(new Error('エンジンを止めた'));
    if (isTauri()) {
      try {
        await invoke('engine_stop', { id: this.config.id });
      } catch (e) {
        this.log('sys', String(e));
      }
    }
    this.setState('stopped');
  }
}
