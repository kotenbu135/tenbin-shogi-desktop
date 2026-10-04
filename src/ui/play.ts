// 対局の進行役。席ごとの対局者（人かエンジンか）を持ち、手番が来た席がエンジンなら考えさせて指す。
//
// 席は 2 つ。天秤将棋では席 A が両玉を置き、席 B が先後を選ぶ。選んだあとは色で席が決まる。
// 布石将棋と任意局面では席 A が先手、席 B が後手。
//
// 人の入力もエンジンの手も、盤に入る経路は main の tryApply 一本。ここは「いま誰の番で、
// それがエンジンなら何を送るか」だけを決める。世代（gen）で古い思考の結果を捨てる。

import type { Game, Color } from '../state/game.ts';
import type { Clock } from '../state/clock.ts';
import type { EngineConfig, Thinker } from '../usi/engine.ts';
import { winrateOfInfo, type UsiInfo } from '../usi/parse.ts';
import { chooseSide, goteKingCandidates, nearestToEven, randomSenteKing } from '../rules/kings.ts';
import { t } from '../i18n.ts';
import { HUMAN_ID, type NewGameChoice, type PlayerSpec } from './newgame.ts';

export interface PlayDeps {
  game(): Game;
  clock(): Clock;
  /** 表示中が最新で、編集中でもないか（エンジンが指してよいか） */
  live(): boolean;
  apply(token: string): void;
  createThinker(id: string, processTag: string): Thinker | null;
  say(text: string, error?: boolean): void;
  onLog(engineName: string, dir: 'in' | 'out' | 'err' | 'sys', text: string): void;
  /** 席のエンジンが考え始めた（読みは検討パネルの「対局の枠」へ） */
  onThinkStart(seat: 0 | 1, color: Color, cfg: EngineConfig): void;
  onThinking(seat: 0 | 1, info: UsiInfo): void;
  /** 指した、または中断した */
  onThinkEnd(seat: 0 | 1, state: string): void;
  /** 対局中のエンジンに送る候補数（MultiPV） */
  multiPv(): number;
  /** その手を今の局面に指せるか */
  canApply(token: string): boolean;
  /** 対局が止まった。自分から止めたときも、エンジンの手が拾えず止まったときも呼ぶ */
  onPause(): void;
}

/** 画面が 1 度描かれるのを待つ。描かれない場（背景のタブなど）でも 60ms で戻る */
function painted(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => setTimeout(fin, 0));
    setTimeout(fin, 60);
  });
}

export class MatchDriver {
  private seats: [PlayerSpec, PlayerSpec] | null = null;
  private names: [string, string] = ['', ''];
  private thinkers = new Map<string, Thinker>();
  private gen = 0;
  private pendingKey: string | null = null;
  private paused = false;
  /** 読みを出している席（中断のときに枠を閉じる） */
  private thinkingSeat: 0 | 1 | null = null;

  constructor(private readonly deps: PlayDeps) {}

  get active(): boolean {
    return this.seats !== null && this.seats.some((s) => s.type === 'engine');
  }

  /** 対局の顔ぶれが決まっているか（人同士でも true） */
  get playing(): boolean {
    return this.seats !== null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * 一時停止。考えているエンジンを止め、結果は捨てる（gen を進めるので、遅れて届く
   * bestmove は着手されない）。再開までどの席も指さない。
   */
  async pause(): Promise<void> {
    if (this.paused || !this.playing) return;
    this.paused = true;
    this.gen++;
    this.pendingKey = null;
    this.endThinking(t('th_paused'));
    // ここで GPU の印は外さない。止めている間に検討へ渡してしまうと、「再開」で取り返せず
    // （検討が読んでいる最中は譲らない）、対局が止まったままになる
    this.deps.onPause();
    await Promise.all([...this.thinkers.values()].map((t) => t.stop()));
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.kick();
  }

  /** 両方の側がエンジンか（人に手を先に見せる心配が無い） */
  get allEngines(): boolean {
    return this.seats !== null && this.seats.every((s) => s.type === 'engine');
  }

  /** 人が指す席が 1 つだけならその席。人が 0 人か 2 人なら null（盤を自動で向ける先） */
  soleHumanSeat(): 0 | 1 | null {
    if (!this.seats) return null;
    const humans = ([0, 1] as const).filter((i) => this.seats![i]!.type === 'human');
    return humans.length === 1 ? humans[0]! : null;
  }

  /** その席の、いまの段階の指し手を人が入れるか */
  humanAt(seat: 0 | 1): boolean {
    const spec = this.seats?.[seat];
    if (!spec) return true;
    if (spec.type === 'human') return true;
    // 段階ごとに人へ渡せる。本将棋のエンジンを指定していない席は 41 手目から人が指し、
    // 布石を「人が置く」にした席は 1〜40 手目を人が置く
    return this.deps.game().phase === 'normal' ? !spec.normalId : spec.fusekiId === HUMAN_ID;
  }

  /** 新しい対局が始まったら呼ぶ（人同士でも呼んでよい） */
  async start(choice: NewGameChoice): Promise<void> {
    this.gen++;
    this.pendingKey = null;
    this.paused = false;
    this.seats = choice.seats;
    this.names = choice.names;
    await Promise.all([...this.thinkers.values()].map((t) => t.newGame()));
    this.kick();
  }

  /** 対局を捨てる（新規・読み込み・編集） */
  async abort(): Promise<void> {
    this.gen++;
    this.pendingKey = null;
    this.paused = false;
    this.endThinking(t('th_aborted'));
    this.seats = null;
    this.names = ['', '']; // 前の対局の名前を、読み込んだ棋譜や編集から始めた対局へ持ち越さない
    this.freeReservations();
    await Promise.all([...this.thinkers.values()].map((t) => t.stop()));
  }

  /** 待ったなど、局面が巻き戻ったとき。考え中の結果は捨て、必要なら考え直す */
  interrupt(): void {
    this.gen++;
    this.pendingKey = null;
    this.endThinking(t('th_aborted'));
    for (const th of this.thinkers.values()) void th.stop();
    this.kick();
  }

  async shutdown(): Promise<void> {
    await this.abort();
    const all = [...this.thinkers.values()];
    this.thinkers.clear();
    await Promise.all(all.map((t) => t.quit()));
  }

  /** 対局が握っている印を外す。GPU を使うエンジンを検討へ渡せるようにする */
  private freeReservations(): void {
    for (const th of this.thinkers.values()) th.reserved = false;
  }

  private endThinking(state: string): void {
    if (this.thinkingSeat === null) return;
    const seat = this.thinkingSeat;
    this.thinkingSeat = null;
    this.deps.onThinkEnd(seat, state);
  }

  /** 席の名前を先手・後手に写す。天秤将棋で先後が決まる前は席 A を先手の欄に置く */
  colorNames(): Record<Color, string> {
    const g = this.deps.game();
    const [a, b] = this.names;
    if (g.mode === 'tenbin') {
      const chosen = g.chosenColor;
      if (chosen === 'sente') return { sente: b, gote: a };
      if (chosen === 'gote') return { sente: a, gote: b };
      return { sente: a ? t('seat_placer', { name: a }) : '', gote: b ? t('seat_chooser', { name: b }) : '' };
    }
    return { sente: a, gote: b };
  }

  /** 席の名前（空なら ''） */
  seatName(seat: 0 | 1): string {
    return this.names[seat];
  }

  seatOfColor(color: Color): 0 | 1 {
    const g = this.deps.game();
    if (g.mode === 'tenbin') {
      const chosen = g.chosenColor;
      if (!chosen) return 0;
      return color === chosen ? 1 : 0;
    }
    return color === 'sente' ? 0 : 1;
  }

  /** いま指す（置く・選ぶ）番の席。対局が無いか終局なら null */
  seatToMove(): 0 | 1 | null {
    const g = this.deps.game();
    if (!this.seats || g.phase === 'over') return null;
    if (g.phase === 'kings') return 0;
    if (g.phase === 'choose') return 1;
    return this.seatOfColor(g.turn);
  }

  /** いま手番の席のエンジン指定。人なら null */
  private currentEngineSeat(): { seat: 0 | 1; spec: Extract<PlayerSpec, { type: 'engine' }> } | null {
    const seat = this.seatToMove();
    if (seat === null || !this.seats) return null;
    const spec = this.seats[seat];
    if (spec.type !== 'engine') return null;
    return { seat, spec };
  }

  /** 局面が変わるたびに呼ぶ。エンジンの番なら考えさせる */
  kick(): void {
    setTimeout(() => void this.maybeMove(), 0);
  }

  private async maybeMove(): Promise<void> {
    const g = this.deps.game();
    if (g.phase === 'over') this.freeReservations(); // 終局したら GPU は検討へ渡してよい
    if (this.paused || !this.deps.live()) return;
    const cur = this.currentEngineSeat();
    if (!cur) return;
    const key = `${g.moves.length}:${cur.seat}`;
    if (this.pendingKey === key) return;
    this.pendingKey = key;
    const gen = this.gen;
    try {
      let token = await this.think(cur.seat, cur.spec);
      if (gen !== this.gen) return;
      if (!this.deps.live()) {
        // 過去の手を見ている間に届いた手は指せない。最新局面へ戻ったときにまた考える
        if (this.pendingKey === key) this.pendingKey = null;
        this.endThinking(t('th_aborted'));
        return;
      }
      if (this.pendingKey !== key) return;
      // エンジンが今の局面で指せない手を返したら、1 度だけ聞き直す。
      // 前の探索の bestmove を拾ってしまう筋が残っており、そこで対局が死んでいた
      if (token && !this.deps.canApply(token)) {
        this.deps.onLog(
          this.names[cur.seat] || t('engine_word'),
          'sys',
          t('pl_bad_move_log', { token, pos: this.deps.game().positionCommand() }),
        );
        this.deps.say(t('pl_bad_move_retry'));
        token = await this.think(cur.seat, cur.spec);
        if (gen !== this.gen) return;
        if (!this.deps.live()) {
          // 聞き直している間に過去の局面へ移ったときも、戻ったら考え直せるようにしておく
          if (this.pendingKey === key) this.pendingKey = null;
          this.endThinking(t('th_aborted'));
          return;
        }
        if (this.pendingKey !== key) return;
      }
      this.pendingKey = null;
      this.endThinking(t('th_moved'));
      if (token && !this.deps.canApply(token)) {
        this.deps.onLog(this.names[cur.seat] || t('engine_word'), 'sys', t('pl_bad_move_twice_log', { token }));
        this.endThinking(t('th_stopped'));
        // pause() は同期のうちに paintAll() 経由で say() を呼ぶので、知らせるのはそのあと
        void this.pause();
        this.deps.say(t('pl_bad_move_stop', { token }), true);
        return;
      }
      if (token) this.deps.apply(token);
    } catch (e) {
      if (gen !== this.gen) return;
      this.pendingKey = null;
      this.endThinking(t('th_stopped'));
      // 止めないと、指す者が居ないまま時計だけ動いて時間切れになる（エンジンが落ちた・応答しない）
      void this.pause();
      this.deps.say(t('pl_engine_error', { msg: e instanceof Error ? e.message : String(e) }), true);
    }
  }

  /** 読みを検討パネルへ流す準備。同じ席の前の読みは閉じる */
  private beginThinking(seat: 0 | 1, color: Color, cfg: EngineConfig): (info: UsiInfo) => void {
    this.endThinking(t('th_moved'));
    this.thinkingSeat = seat;
    this.deps.onThinkStart(seat, color, cfg);
    const gen = this.gen;
    return (info) => {
      if (gen === this.gen && this.thinkingSeat === seat) this.deps.onThinking(seat, info);
    };
  }

  private thinker(seat: 0 | 1, id: string): Thinker {
    const key = `${seat}:${id}`;
    let th = this.thinkers.get(key);
    if (!th) {
      // 同じエンジンを先後で使う対局は、席ごとに 1 本ずつ立てるのが普通。ただし GPU で読むエンジンは
      // 同時に 1 本しか立てられない（VRAM）ので、先後で同じ process を使い回す。
      // 対局は手番が交互で 2 つの go が重ならないので成り立つ（検討と重ねるのは駄目）
      const shared = [...this.thinkers.values()].find((x) => x.config.id === id && x.config.gpu);
      th = shared ?? this.deps.createThinker(id, `play${seat}`) ?? undefined;
      if (!th) throw new Error(t('pl_engine_gone'));
      th.onLog = (dir, text) => this.deps.onLog(th!.config.name || th!.config.path, dir, text);
      this.thinkers.set(key, th);
    }
    // 対局の持ち物であることを示す。GPU は 1 本しか立たないので、手番の合間に検討へ取られると
    // 毎手 模型を読み直すことになる
    th.reserved = true;
    return th;
  }

  /**
   * 席のエンジンを立てる。GPU で読むエンジンは模型を読むのに何分もかかるので、そのあいだ時計を止める
   * （起動を待っている側が、1 手も指さないうちに時間切れになるのを防ぐ）。
   * 途中経過は状態の行に出す。何分も黙っていると、止まったのか動いているのか分からない。
   */
  private async ensureStarted(th: Thinker): Promise<void> {
    if (th.state !== 'stopped' && th.state !== 'starting') return;
    const name = th.config.name || th.config.path;
    this.deps.say(t('pl_starting', { name }));
    const clock = this.deps.clock();
    const wasPaused = clock.isPaused;
    if (!wasPaused) clock.pause();
    th.onStatus = (text) => this.deps.say(t('pl_starting_note', { name, text }));
    try {
      await th.start();
      await th.newGame();
    } finally {
      th.onStatus = null;
      // 起動の途中で対局を止めていたら、そのまま止めておく（止めた側の時計を勝手に動かさない）
      if (!wasPaused && !this.paused) clock.resume();
    }
  }

  /**
   * 対局中の候補数。既定の MultiPV は 1 なので、送らないと候補手の欄に 1 行しか出ない。
   * 増やすと読みは少し落ちるので、数は利用者が決める（候補手の欄の「候補」）。
   */
  private sendMultiPv(th: Thinker): void {
    if (!th.hasOption('MultiPV')) return;
    th.setOption('MultiPV', Math.max(1, Math.round(this.deps.multiPv())));
  }

  private goArgs(spec: Extract<PlayerSpec, { type: 'engine' }>, choosing = false): string {
    const c = this.deps.clock();
    if (c.enabled && c.control) {
      // 先後の選択は盤の手番（先手）として読ませるが、減るのは選ぶ側の時計（後手の枠）。その残りを両方に渡す
      if (choosing) {
        const ms = c.remainingMs(this.deps.game().actingColor);
        return `btime ${ms} wtime ${ms} byoyomi ${c.control.byoyomiSec * 1000}`;
      }
      return `btime ${c.remainingMs('sente')} wtime ${c.remainingMs('gote')} byoyomi ${c.control.byoyomiSec * 1000}`;
    }
    return `movetime ${spec.secPerMove * 1000}`;
  }

  private async think(seat: 0 | 1, spec: Extract<PlayerSpec, { type: 'engine' }>): Promise<string | null> {
    const g = this.deps.game();
    const phase = g.phase;
    const color = g.turn;
    if (phase === 'normal') {
      if (!spec.normalId) return null; // 本将棋は人が指す
      const th = this.thinker(seat, spec.normalId);
      await this.ensureStarted(th);
      this.sendMultiPv(th);
      // 入玉宣言はこのアプリが条件を確かめて裁くので、宣言できるエンジンには宣言させる。
      // 利用者がエンジンの設定で決めていれば、そちらに従う
      if (th.hasOption('Declare_Win') && th.config.options['Declare_Win'] === undefined) th.setOption('Declare_Win', 'true');
      const bm = await th.go(g.positionCommand(), this.goArgs(spec), this.beginThinking(seat, color, th.config));
      if (bm.move === 'resign') return 'resign';
      if (bm.move === 'win') this.deps.say(t('pl_declare_win', { name: th.config.name }));
      return bm.move;
    }
    // 布石（両玉・選択・駒打ち）は「布石にも対応」のエンジンが指す
    if (spec.fusekiId === HUMAN_ID) return null; // 布石は人が置く
    const tenbin = g.mode === 'tenbin';
    const th = this.thinker(seat, spec.fusekiId);
    await this.ensureStarted(th);
    const knowsMode = th.hasOption('Fuseki_Mode');
    this.sendMultiPv(th);
    // 布石は天秤将棋と布石将棋で最初の 2 手の意味が違う。position 行からは区別できないので渡す
    if (knowsMode) th.setOption('Fuseki_Mode', tenbin ? 'tenbin' : 'fuseki');
    // ルールの版は position より先に送る（外のエンジンは次の position の盤から版を効かせる）
    if (th.hasOption('Fuseki_Rules')) th.setOption('Fuseki_Rules', g.rules);
    if (phase === 'choose') return `choose:${chooseSide(await this.engineChoose(seat, th, spec, color))}`;
    // Fuseki_Mode を名乗るエンジン（Libra 0.3 以降）は両玉も自分で読んで置く（公開サイトと同じ形）。
    // 名乗らないエンジンは 1〜2 手目に玉を置く決まりを知らないので、同じ形をここで組む
    if (phase === 'kings' && !knowsMode) return this.placeKing(seat, th, spec, color);
    const bm = await th.go(g.positionCommand(), this.goArgs(spec), this.beginThinking(seat, color, th.config));
    return bm.move === 'resign' ? 'resign' : bm.move;
  }

  /**
   * 両玉を置く（rules/kings.ts）。先手玉は乱数、後手玉は候補ごとに両玉を置いた局面を読ませ、
   * 先手の勝率が 0.5 にいちばん近いマス。1 手ぶんの時間を候補の数で割って読ませる
   */
  private async placeKing(
    seat: 0 | 1,
    th: Thinker,
    spec: Extract<PlayerSpec, { type: 'engine' }>,
    color: Color,
  ): Promise<string> {
    const g = this.deps.game();
    const squares = g.dropSquares('king');
    if (g.tokens().length === 0) {
      const usi = randomSenteKing(squares);
      if (!usi) throw new Error(t('pl_no_king_square'));
      return usi;
    }
    const cands = goteKingCandidates(squares);
    if (cands.length === 0) throw new Error(t('pl_no_king_square'));
    const gen = this.gen;
    const show = this.beginThinking(seat, color, th.config);
    const each = Math.max(100, Math.floor(this.moveBudgetMs(spec) / cands.length));
    const base = g.positionCommand();
    const rates = new Map<string, number>();
    for (const [i, usi] of cands.entries()) {
      if (gen !== this.gen) break;
      let p: number | null = null;
      await th.go(`${base}${base.includes(' moves ') ? '' : ' moves'} ${usi}`, `movetime ${each}`, (info) => {
        if ((info.multipv ?? 1) !== 1) return;
        const w = winrateOfInfo(info, th.config.eval.scale, th.config.eval.offsetCp);
        if (w !== null) p = w;
      });
      // 読んだ局面は先手の番なので、手番側の勝率がそのまま先手の勝率
      if (p !== null) rates.set(usi, p);
      show({ multipv: i + 1, pv: [usi], winrate: 1 - (p ?? 0.5), string: `place ${usi}` } as UsiInfo);
    }
    return nearestToEven(rates) ?? cands[0]!;
  }

  /** 1 手に使ってよい時間（ミリ秒）。持ち時間があれば秒読み、無ければ残りの 1/40 */
  private moveBudgetMs(spec: Extract<PlayerSpec, { type: 'engine' }>): number {
    const c = this.deps.clock();
    if (c.enabled && c.control) {
      if (c.control.byoyomiSec > 0) return c.control.byoyomiSec * 1000;
      return Math.max(1000, Math.floor(c.remainingMs(this.deps.game().actingColor) / 40));
    }
    return spec.secPerMove * 1000;
  }

  /**
   * 天秤将棋の先後の選択を外の布石エンジンに決めさせる。両玉を置いた局面（手番は先手）を読ませ、
   * 最善の候補の勝率（＝先手の勝率）を返す。0.5 以上なら先手を持つ（Libra の docs/protocol.md §2 のハーネス、公開サイトと同じ）。
   * 返った bestmove は 3 手目の候補なので指さない。評価が 1 行も来なければ null（先手を持つ）
   */
  private async engineChoose(
    seat: 0 | 1,
    th: Thinker,
    spec: Extract<PlayerSpec, { type: 'engine' }>,
    color: Color,
  ): Promise<number | null> {
    const g = this.deps.game();
    const show = this.beginThinking(seat, color, th.config);
    const best = { p: null as number | null };
    await th.go(g.positionCommand(), this.goArgs(spec, true), (info) => {
      show(info);
      if ((info.multipv ?? 1) !== 1) return;
      const p = winrateOfInfo(info, th.config.eval.scale, th.config.eval.offsetCp);
      if (p !== null) best.p = p;
    });
    return best.p;
  }
}
