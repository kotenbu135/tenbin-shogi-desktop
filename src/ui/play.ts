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
import type { UsiInfo } from '../usi/parse.ts';
import { BuiltinEvaluator } from '../eval/builtin.ts';
import { BUILTIN_ID } from '../settings.ts';
import { LEVELS, type NewGameChoice, type PlayerSpec } from './newgame.ts';

export interface PlayDeps {
  game(): Game;
  clock(): Clock;
  /** 表示中が最新で、編集中でもないか（エンジンが指してよいか） */
  live(): boolean;
  apply(token: string): void;
  builtin(): BuiltinEvaluator | null;
  createThinker(id: string, processTag: string): Thinker | null;
  say(text: string, error?: boolean): void;
  onLog(engineName: string, dir: 'in' | 'out' | 'err' | 'sys', text: string): void;
  /** 席のエンジンが考え始めた（読みは検討パネルの「対局の枠」へ） */
  onThinkStart(seat: 0 | 1, color: Color, cfg: EngineConfig): void;
  onThinking(seat: 0 | 1, info: UsiInfo): void;
  /** 指した、または中断した */
  onThinkEnd(seat: 0 | 1, state: string): void;
}

export class MatchDriver {
  private seats: [PlayerSpec, PlayerSpec] | null = null;
  private names: [string, string] = ['', ''];
  private thinkers = new Map<string, Thinker>();
  private gen = 0;
  private pendingKey: string | null = null;
  /** 読みを出している席（中断のときに枠を閉じる） */
  private thinkingSeat: 0 | 1 | null = null;

  constructor(private readonly deps: PlayDeps) {}

  get active(): boolean {
    return this.seats !== null && this.seats.some((s) => s.type === 'engine');
  }

  /** 新しい対局が始まったら呼ぶ（人同士でも呼んでよい） */
  async start(choice: NewGameChoice): Promise<void> {
    this.gen++;
    this.pendingKey = null;
    this.seats = choice.seats;
    this.names = choice.names;
    await Promise.all([...this.thinkers.values()].map((t) => t.newGame()));
    this.kick();
  }

  /** 対局を捨てる（新規・読み込み・編集） */
  async abort(): Promise<void> {
    this.gen++;
    this.pendingKey = null;
    this.endThinking('中断');
    this.seats = null;
    await Promise.all([...this.thinkers.values()].map((t) => t.stop()));
  }

  /** 待ったなど、局面が巻き戻ったとき。考え中の結果は捨て、必要なら考え直す */
  interrupt(): void {
    this.gen++;
    this.pendingKey = null;
    this.endThinking('中断');
    for (const t of this.thinkers.values()) void t.stop();
    this.kick();
  }

  async shutdown(): Promise<void> {
    await this.abort();
    const all = [...this.thinkers.values()];
    this.thinkers.clear();
    await Promise.all(all.map((t) => t.quit()));
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
      return { sente: a ? `${a}（玉を置く）` : '', gote: b ? `${b}（先後を選ぶ）` : '' };
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

  /** いま手番の席のエンジン指定。人なら null */
  private currentEngineSeat(): { seat: 0 | 1; spec: Extract<PlayerSpec, { type: 'engine' }> } | null {
    const g = this.deps.game();
    if (!this.seats || g.phase === 'over') return null;
    let seat: 0 | 1;
    if (g.phase === 'kings') seat = 0;
    else if (g.phase === 'choose') seat = 1;
    else seat = this.seatOfColor(g.turn);
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
    if (!this.deps.live()) return;
    const cur = this.currentEngineSeat();
    if (!cur) return;
    const key = `${g.moves.length}:${cur.seat}`;
    if (this.pendingKey === key) return;
    this.pendingKey = key;
    const gen = this.gen;
    try {
      const token = await this.think(cur.seat, cur.spec);
      if (gen !== this.gen || !this.deps.live()) return;
      if (this.pendingKey !== key) return;
      this.pendingKey = null;
      this.endThinking('指した');
      if (token) this.deps.apply(token);
    } catch (e) {
      if (gen !== this.gen) return;
      this.pendingKey = null;
      this.endThinking('止まった');
      this.deps.say(`エンジンが指せない: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /** 読みを検討パネルへ流す準備。同じ席の前の読みは閉じる */
  private beginThinking(seat: 0 | 1, color: Color, cfg: EngineConfig): (info: UsiInfo) => void {
    this.endThinking('指した');
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
      th = this.deps.createThinker(id, `play${seat}`) ?? undefined;
      if (!th) throw new Error('エンジンが登録から消えている');
      th.onLog = (dir, text) => this.deps.onLog(th!.config.name || th!.config.path, dir, text);
      this.thinkers.set(key, th);
    }
    return th;
  }

  private goArgs(spec: Extract<PlayerSpec, { type: 'engine' }>): string {
    const c = this.deps.clock();
    if (c.enabled && c.control) {
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
      if (th.state === 'stopped') {
        this.deps.say(`${th.config.name} を起動しています…`);
        await th.start();
        await th.newGame();
      }
      const bm = await th.go(g.positionCommand(), this.goArgs(spec), this.beginThinking(seat, color, th.config));
      if (bm.move === 'resign') return 'resign';
      if (bm.move === 'win') {
        this.deps.say(`${th.config.name} が入玉宣言をしました（このアプリでは扱えないので投了として記録します）`, true);
        return 'resign';
      }
      return bm.move;
    }
    // 布石（両玉・選択・駒打ち）
    const tokens = g.tokens().filter((t) => !t.startsWith('choose:'));
    const tenbin = g.mode === 'tenbin';
    const lv = LEVELS.find((l) => l.level === spec.level) ?? LEVELS[3]!;
    const builtin = this.deps.builtin();
    if (phase === 'choose') {
      const kb = tokens[0]!.slice(2);
      const kw = tokens[1]!.slice(2);
      return `choose:${builtin ? builtin.choose(kb, kw) : 'sente'}`;
    }
    if (spec.fusekiId === BUILTIN_ID || phase === 'kings') {
      if (!builtin) throw new Error('内蔵の布石評価が読み込まれていない');
      // 候補と勝率を対局の枠とグラフに出してから、温度で 1 手を選ぶ（選ぶ手は 1 位とは限らない）
      const onInfo = this.beginThinking(seat, color, builtin.config);
      try {
        await builtin.start();
        await builtin.goInfinite(g.positionCommand(), onInfo);
      } catch (e) {
        this.deps.onLog('内蔵の布石評価', 'sys', `候補を出せない: ${e instanceof Error ? e.message : String(e)}`);
      }
      return builtin.pickMove(tokens, { temperature: lv.temperature, search: lv.search, tenbin });
    }
    const th = this.thinker(seat, spec.fusekiId);
    if (th.state === 'stopped') {
      this.deps.say(`${th.config.name} を起動しています…`);
      await th.start();
      await th.newGame();
    }
    const bm = await th.go(g.positionCommand(), this.goArgs(spec), this.beginThinking(seat, color, th.config));
    return bm.move === 'resign' ? 'resign' : bm.move;
  }
}
