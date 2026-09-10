// USI エンジン1本の状態機械。プロセスの起動と行の往復は Tauri（Rust の usi-host）が担い、
// ここは語彙の解釈と「go を重ねない」規律を持つ。
//
// 1つのエンジンに go を重ねてはいけない。重ねると bestmove の待ち合わせが交差して、
// 検討の待ち手に対局の指し手が返る（またはその逆）。落ちずに、盤に入る手だけが入れ替わる。

import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n.ts';
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
   * GPU（DNN）で読むエンジンか。dlshogi・ふかうら王など。
   * 立つのは同時に 1 本だけ（VRAM は席の数だけ増えない）で、準備を長く待つ。
   * 申告に `DNN_` で始まる項目があれば登録のときに立てる。利用者が外せる。
   */
  gpu?: boolean;
  /** isready の返事を待つ秒数。省略時は GPU なら {@link GPU_READY_SEC}、それ以外 {@link READY_SEC} */
  readySec?: number;
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

/** よく触る項目は先頭に出す。残りは申告順。GPU のエンジンは名前が違う（Threads ではなく UCT_Threads） */
export const COMMON_OPTIONS = [
  'Threads', 'USI_Hash', 'MultiPV', 'EvalDir', 'BookFile', 'USI_OwnBook', 'FV_SCALE', 'NetworkDelay', 'NetworkDelay2',
  'UCT_Threads', 'DNN_Model', 'DNN_Batch_Size', 'UCT_NodeLimit', 'Eval_Coef',
];

/** 一覧の見出しに出す項目（持っているものだけ、この順に 3 つまで） */
export const SUMMARY_OPTIONS = ['Threads', 'UCT_Threads', 'USI_Hash', 'DNN_Model', 'DNN_Batch_Size', 'EvalDir'];

/** 普通のエンジンの isready を待つ秒数 */
export const READY_SEC = 120;
/**
 * GPU のエンジンの isready を待つ秒数。初回は模型を GPU 向けに組み直すため
 * （TensorRT の最適化）5〜15 分かかることがある。2 回目からは残った結果を使うので速い。
 */
export const GPU_READY_SEC = 1200;

/** GPU（DNN）で読むエンジンか。dlshogi 系は `DNN_` で始まる項目を申告する */
export function usesGpu(options: UsiOption[]): boolean {
  return options.some((o) => /^DNN_/.test(o.name));
}

/** そのエンジンの isready を待つ秒数 */
export function readySecOf(cfg: Pick<EngineConfig, 'gpu' | 'readySec'>): number {
  const v = cfg.readySec;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.max(10, Math.round(v));
  return cfg.gpu ? GPU_READY_SEC : READY_SEC;
}

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

/**
 * いま GPU を握っているエンジン。GPU は 1 枚しか無いのが普通で、模型を読んだ process を
 * 席の数だけ立てると VRAM が尽きて落ちる。だから GPU のエンジンは同時に 1 本だけ立てる。
 * 使い回して 2 か所から go を送るのは駄目（このファイルの冒頭の規律）なので、断るのが正しい。
 */
let gpuHolder: UsiEngine | null = null;

async function claimGpu(e: UsiEngine): Promise<void> {
  if (!e.config.gpu) return;
  const held = gpuHolder;
  if (!held || held === e || held.state === 'stopped') {
    gpuHolder = e;
    return;
  }
  const name = held.config.name || held.idName || held.config.path;
  // 準備の途中のものは畳めない。その起動を待っている側（検討の枠・対局）が黙って失敗する
  if (held.state === 'starting') throw new Error(t('eng_gpu_starting', { name }));
  // 読んでいる最中のものも畳めない。待っている側（対局の go）の答えを奪うことになる
  if (held.state !== 'ready') throw new Error(t('eng_gpu_busy', { name }));
  // 対局が握っているものも畳まない。手番の合間の「空き」で取り上げると、毎手 模型を読み直す
  if (held.reserved) throw new Error(t('eng_gpu_in_game', { name }));
  // 空いているだけなら、その process を畳んで GPU を渡す。1 本を 2 か所で使い回してはいけない
  // （このファイルの冒頭の規律）ので、立て直す
  e.onLog?.('sys', t('eng_gpu_freed_log', { name }));
  e.onStatus?.(t('eng_gpu_freed', { name }));
  await held.quit();
  gpuHolder = e;
}

function releaseGpu(e: UsiEngine): void {
  if (gpuHolder === e) gpuHolder = null;
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
  /** 起動の途中経過（GPU のエンジンは準備に何分もかかるので、黙って待たせない） */
  onStatus?: ((text: string) => void) | null;
  /** 対局が握っている。手番の合間で空いていても、GPU を他へ渡さない */
  reserved?: boolean;
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
  onStatus: ((text: string) => void) | null = null;
  /** 対局が握っている。手が返ったあとの「空き」で GPU を取り上げられると、毎手 模型を読み直すことになる */
  reserved = false;
  private waiters: Waiter[] = [];
  private onInfo: ((info: UsiInfo) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** 進行中の起動。重ねて start() されたときに同じものを待たせる */
  private starting: Promise<void> | null = null;
  /** 何度目の起動か。自分の起動が既に古くなっていないかを見るために持つ */
  private startToken = 0;
  /** process が落ちたか。起動の途中で落ちたときに、応答を待たずに失敗させる */
  private exited = false;
  /** process を立てたか。立てる前に失敗した起動（GPU の空き待ちなど）で、居ない子を止めに行かない */
  private spawned = false;
  /** 止めたのに応答が無かった探索の数。遅れて届く bestmove をその数だけ捨てる */
  private stale = 0;
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
    if (!isTauri()) throw new Error(t('eng_tauri_only'));
    // 起動中に重ねて呼ばれたら、同じ起動を待つ（先に go() へ進むと「準備できていない」で落ちる）
    if (this.starting) return this.starting;
    if (this.state !== 'stopped') return;
    this.setState('starting');
    const token = ++this.startToken;
    this.starting = (async () => {
      try {
        await claimGpu(this);
        await this.spawn();
        this.send('usi');
        await this.waitFor((l) => l === 'usiok', 15000);
        this.applyOptions();
        this.send('isready');
        await this.waitReady();
        this.setState('ready');
      } catch (e) {
        // 既に次の起動が始まっていたら、そちらの process を巻き添えに殺さない
        if (this.startToken === token) await this.quit();
        throw e;
      } finally {
        // 自分の起動だけを片づける。既に次の起動が入っていたらそちらを消さない
        if (this.startToken === token) this.starting = null;
      }
    })();
    return this.starting;
  }

  /**
   * isready の返事を待つ。GPU のエンジンは模型を読み、初回は GPU 向けに組み直すので長い。
   * 待ちきれなかったときは「待つ秒数を増やせる」ことまで言う（同じ失敗を繰り返させない）。
   */
  private async waitReady(): Promise<void> {
    const sec = readySecOf(this.config);
    this.status(this.config.gpu ? t('eng_loading_gpu') : t('eng_loading'));
    try {
      await this.waitFor((l) => l === 'readyok', sec * 1000);
    } catch (e) {
      if (this.exited) throw e;
      throw new Error(t('eng_ready_timeout', { sec }));
    }
  }

  /** 起動の途中経過を伝える。画面に出るのは起動中だけ */
  private status(text: string): void {
    this.onStatus?.(text);
  }

  private async spawn(): Promise<void> {
    this.exited = false;
    this.stale = 0;
    this.spawned = true;
    await ensureListener();
    receivers.set(this.processId, (p) => this.receive(p));
    await invoke('engine_start', {
      id: this.processId,
      path: this.config.path,
      args: (this.config.args ?? '').split(/\s+/).filter(Boolean),
      cwd: this.config.cwd || null,
    });
    this.log('sys', t('eng_started', { path: this.config.path }));
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

  /** いま bestmove を 1 つ待っているか（探索は 1 つの処理につき 1 本だけ） */
  private expecting = false;

  private receive(p: EnginePayload): void {
    if (p.kind === 'exit') {
      // 終了コードは、何も言わずに落ちたときの唯一の手がかり（GPU のエンジンは CUDA や
      // TensorRT の DLL が揃っていないと、標準エラーに 1 行も出さずに即死する）
      const code = p.code ?? null;
      this.log('sys', code === null ? t('eng_exited_log') : t('eng_exited_code_log', { code }));
      this.expecting = false;
      this.exited = true;
      this.starting = null; // 落ちた起動を掴ませない（次の start() は新しく立ち上げる）
      releaseGpu(this);
      this.failWaiters(new Error(code === null || code === 0 ? t('eng_exited') : t('eng_exited_code', { code })));
      receivers.delete(this.processId);
      this.setState('stopped');
      return;
    }
    const line = (p.line ?? '').replace(/\r$/, '');
    if (p.kind === 'stderr') {
      this.log('err', line);
      // 準備の途中の進み具合はここに出る実装が多い。起動中だけ画面へ回す
      if (this.state === 'starting' && line.trim()) this.status(line.trim().slice(0, 120));
      return;
    }
    this.log('in', line);
    const id = parseId(line);
    if (id?.name) this.idName = id.name;
    if (id?.author) this.idAuthor = id.author;
    const opt = parseOption(line);
    if (opt) this.options.push(opt);
    if (this.state === 'starting' && line.startsWith('info string')) this.status(line.slice('info string'.length).trim().slice(0, 120));
    if (line.startsWith('info')) {
      const info = parseInfo(line);
      if (info && (info.scoreCp !== undefined || info.scoreMate !== undefined || info.winrate !== undefined || info.string !== undefined)) {
        this.onInfo?.(info);
      }
    }
    if (line.startsWith('bestmove')) {
      // 止めたのに応答しなかった探索の bestmove は、次の go を走らせたあとで届くことがある。
      // expecting は立て直されているので、捨てる分をここで数えておく
      if (this.stale > 0) {
        this.stale--;
        this.log('sys', t('eng_stale_bestmove', { line }));
        return;
      }
      // 走らせていないのに来た bestmove は捨てる。止めたあとのエンジンが余分に返すことがあり、
      // それを次の go の答えとして拾うと、1 手前の局面の手を指してしまう
      if (!this.expecting) {
        this.log('sys', t('eng_extra_bestmove', { line }));
        return;
      }
      this.expecting = false;
      // ここで「思考中」を解く。go() の finally を待つと 1 タスク遅れ、そのあいだの stop() が
      // 探索の終わったエンジンへ余計な stop を送ってしまう（返ってくる bestmove が次の go に混ざる）
      if (this.state === 'thinking') this.setState('ready');
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
    // 起動の途中で process が落ちたときは待たない（15 秒待っても何も来ない）
    if (this.exited) return Promise.reject(new Error(t('eng_exited')));
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(new Error(t('eng_no_response', { sec: timeoutMs / 1000 })));
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
    if (this.state === 'stopped' || this.state === 'starting') throw new Error(t('eng_not_ready'));
    await this.stop();
    this.onInfo = onInfo;
    this.setState('thinking');
    this.send(positionCmd);
    this.send('go infinite');
    this.expecting = true;
  }

  /** 1手指させて bestmove を待つ。途中で stop() されたときも、そのとき返った bestmove で解決する。 */
  async go(positionCmd: string, goArgs: string, onInfo?: (info: UsiInfo) => void): Promise<Bestmove> {
    if (this.state === 'stopped' || this.state === 'starting') throw new Error(t('eng_not_ready'));
    await this.stop();
    this.onInfo = onInfo ?? null;
    this.setState('thinking');
    const p = this.waitFor((l) => l.startsWith('bestmove'), 3_600_000);
    this.send(positionCmd);
    this.send(`go ${goArgs}`.trim());
    this.expecting = true;
    try {
      const line = await p;
      const bm = parseBestmove(line);
      if (!bm) throw new Error(t('eng_bad_bestmove', { line }));
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
        // 応答しないエンジンの bestmove は、遅れて届いても次の go の答えとして拾わない。
        // 待っていた go() は失敗させる（黙って前の局面の手を返すよりよい）
        this.expecting = false;
        this.stale++;
        this.failWaiters(new Error(t('eng_stop_ignored')));
      }
      if (this.state === 'thinking') this.setState('ready');
    };
    const next = this.chain.then(run, run);
    this.chain = next.then(() => undefined, () => undefined);
    await next;
  }

  async quit(): Promise<void> {
    this.onInfo = null;
    this.expecting = false;
    this.starting = null;
    releaseGpu(this);
    receivers.delete(this.processId);
    this.failWaiters(new Error(t('eng_killed')));
    if (isTauri() && this.spawned) {
      this.spawned = false;
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
