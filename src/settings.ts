// 設定の保存。Tauri では plugin-store（アプリのデータフォルダの settings.json）、
// ブラウザのプレビューでは localStorage に落とす。中身の形は同じ。

import { isTauri, type EngineConfig } from './usi/engine.ts';
import { DEFAULT_EVAL, type EvalScale } from './usi/evalscale.ts';
import type { UsiOption } from './usi/parse.ts';

/** 内蔵の布石評価を指す id。エンジンの一覧には出さず、布石の側の既定として使う */
export const BUILTIN_ID = 'builtin';

export interface Settings {
  engines: EngineConfig[];
  theme: 'system' | 'light' | 'dark';
  /** 41 手目以降の既定エンジン。未設定なら最初の本将棋エンジン */
  normalEngineId?: string;
  /** 布石の既定。内蔵か、布石対応のエンジン id */
  fusekiEngineId: string;
  /** 検討の候補数（MultiPV を持つエンジンに送る） */
  analysisMultiPv: number;
  /** 対局中のエンジンに送る候補数（MultiPV）。増やすと候補が並ぶが読みは少し落ちる */
  playMultiPv: number;
  /** 検討の枠に選んだエンジン（'auto' は局面で自動）。1 つ目が主 */
  analysisSlots: string[];
  /** 内蔵の布石評価の方式 */
  builtinMethod: 'value' | 'twoply';
  /** 棋譜解析の 1 局面の秒数 */
  kifuAnalysisSec: number;
  /** 画面の割りつけ（仕切りの位置と、下の欄で開いているタブ） */
  layout: LayoutSettings;
  /** はじめの案内を見たか（初回だけ自動で出す） */
  seenSetup: boolean;
}

/** 下の欄に置けるもの */
export type TabId = 'play' | 'analysis' | 'score' | 'winrate';

export const ALL_TABS: TabId[] = ['play', 'analysis', 'score', 'winrate'];

/** 欄が足りないときに寄せる相手（候補手は検討の隣、評価値は期待勝率の隣） */
const NEIGHBOUR: Record<TabId, TabId> = { play: 'analysis', analysis: 'play', score: 'winrate', winrate: 'score' };

/** 下の欄の 1 つ。タブを何枚か持ち、そのうち 1 枚を開いている */
export interface PaneSettings {
  tabs: TabId[];
  active: TabId;
  /** 横幅の取り分（欄どうしの比） */
  ratio: number;
}

export interface LayoutSettings {
  /** 棋譜の欄の幅（px） */
  recordWidth: number;
  /** 下の欄の高さ（px） */
  bottomHeight: number;
  /** 下の欄の並び。左から順に */
  panes: PaneSettings[];
}

/** 既定は 2 欄。候補手（検討）とグラフを同時に見られるようにする */
/** 高さの既定は「候補 3 手ぶんがちょうど収まる」ところ（実測 246px + わずかな余裕） */
export const DEFAULT_LAYOUT: LayoutSettings = {
  recordWidth: 320,
  bottomHeight: 248,
  panes: [
    { tabs: ['play', 'analysis'], active: 'play', ratio: 0.56 },
    { tabs: ['score', 'winrate'], active: 'score', ratio: 0.44 },
  ],
};

export function defaultSettings(): Settings {
  return {
    engines: [],
    theme: 'system',
    fusekiEngineId: BUILTIN_ID,
    analysisMultiPv: 3,
    playMultiPv: 3,
    analysisSlots: ['auto'],
    builtinMethod: 'value',
    kifuAnalysisSec: 2,
    layout: { ...DEFAULT_LAYOUT },
    seenSetup: false,
  };
}

const KEY = 'settings';
const FILE = 'settings.json';

type StoreLike = {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

let store: StoreLike | null = null;

async function getStore(): Promise<StoreLike | null> {
  if (!isTauri()) return null;
  if (!store) {
    const { load } = await import('@tauri-apps/plugin-store');
    store = await load(FILE, { autoSave: false, defaults: {} });
  }
  return store;
}

/** 以前の形（threads / hashMb / multiPv / evalDir と全体の winrate）を options と eval へ写す */
export interface LegacyEngine extends Partial<EngineConfig> {
  threads?: number;
  hashMb?: number;
  multiPv?: number;
  evalDir?: string;
}

export function migrateEngine(raw: LegacyEngine, globalEval?: EvalScale): EngineConfig | null {
  if (!raw || typeof raw.path !== 'string' || !raw.path) return null;
  const options: Record<string, string> = { ...(raw.options ?? {}) };
  if (raw.threads !== undefined && options.Threads === undefined) options.Threads = String(raw.threads);
  if (raw.hashMb !== undefined && options.USI_Hash === undefined) options.USI_Hash = String(raw.hashMb);
  if (raw.multiPv !== undefined && options.MultiPV === undefined) options.MultiPV = String(raw.multiPv);
  if (raw.evalDir && options.EvalDir === undefined) options.EvalDir = raw.evalDir;
  return {
    id: raw.id ?? 'e' + Math.random().toString(36).slice(2, 10),
    name: raw.name ?? '',
    path: raw.path,
    args: raw.args || undefined,
    cwd: raw.cwd || undefined,
    kind: raw.kind === 'fuseki' ? 'fuseki' : 'normal',
    options,
    declared: Array.isArray(raw.declared) ? (raw.declared as UsiOption[]) : undefined,
    idName: raw.idName,
    idAuthor: raw.idAuthor,
    eval: raw.eval && typeof raw.eval.scale === 'number' ? { scale: raw.eval.scale, offsetCp: raw.eval.offsetCp ?? 0 } : { ...(globalEval ?? DEFAULT_EVAL) },
  };
}

export function merge(saved: (Partial<Settings> & { winrate?: EvalScale; analysisEngineId?: string }) | null | undefined): Settings {
  const d = defaultSettings();
  if (!saved) return d;
  const engines = Array.isArray(saved.engines) ? saved.engines.map((e) => migrateEngine(e as LegacyEngine, saved.winrate)).filter((e): e is EngineConfig => e !== null) : [];
  const s: Settings = {
    ...d,
    theme: saved.theme ?? d.theme,
    engines,
    normalEngineId: saved.normalEngineId ?? saved.analysisEngineId,
    fusekiEngineId: saved.fusekiEngineId ?? d.fusekiEngineId,
    analysisMultiPv: saved.analysisMultiPv ?? d.analysisMultiPv,
    playMultiPv: typeof saved.playMultiPv === 'number' && saved.playMultiPv >= 1 ? Math.min(10, Math.round(saved.playMultiPv)) : d.playMultiPv,
    analysisSlots: Array.isArray(saved.analysisSlots) && saved.analysisSlots.length ? saved.analysisSlots : d.analysisSlots,
    builtinMethod: saved.builtinMethod === 'twoply' ? 'twoply' : 'value',
    kifuAnalysisSec: typeof saved.kifuAnalysisSec === 'number' && saved.kifuAnalysisSec > 0 ? saved.kifuAnalysisSec : d.kifuAnalysisSec,
    layout: mergeLayout(saved.layout),
    seenSetup: saved.seenSetup === true,
  };
  if (s.normalEngineId && !engines.some((e) => e.id === s.normalEngineId)) s.normalEngineId = undefined;
  if (s.fusekiEngineId !== BUILTIN_ID && !engines.some((e) => e.id === s.fusekiEngineId)) s.fusekiEngineId = BUILTIN_ID;
  return s;
}

/** 既定の並びを複製する（設定を書き換えても定数が壊れないように） */
export function defaultPanes(): PaneSettings[] {
  return DEFAULT_LAYOUT.panes.map((p) => ({ tabs: [...p.tabs], active: p.active, ratio: p.ratio }));
}

/**
 * 保存された割りつけを読む。壊れた値と、古い形（タブ 1 枚を覚えるだけの `tab`）を受ける。
 * タブは全部ちょうど 1 か所に居ることを保証する（欠けたら最後の欄へ、重複は先に出たほうを残す）。
 */
function mergeLayout(raw: (Partial<LayoutSettings> & { tab?: string }) | undefined): LayoutSettings {
  const d = DEFAULT_LAYOUT;
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
  const panes: PaneSettings[] = [];
  const seen = new Set<TabId>();
  for (const p of Array.isArray(raw?.panes) ? raw!.panes! : []) {
    const tabs = (Array.isArray(p?.tabs) ? p.tabs : []).filter((t): t is TabId => ALL_TABS.includes(t as TabId) && !seen.has(t as TabId));
    if (tabs.length === 0) continue;
    for (const t of tabs) seen.add(t);
    panes.push({
      tabs,
      active: tabs.includes(p.active as TabId) ? (p.active as TabId) : tabs[0]!,
      ratio: typeof p.ratio === 'number' && p.ratio > 0 && Number.isFinite(p.ratio) ? p.ratio : 1,
    });
  }
  if (panes.length === 0) {
    // 古い形。開いていたタブを、既定の並びの中で開き直す
    panes.push(...defaultPanes());
    const legacy = ALL_TABS.find((t) => t === raw?.tab);
    if (legacy) for (const p of panes) if (p.tabs.includes(legacy)) p.active = legacy;
    for (const p of panes) for (const t of p.tabs) seen.add(t);
  }
  // 版を上げて増えたタブは、相方の居る欄へ（無ければ最後の欄へ）
  for (const t of ALL_TABS) {
    if (seen.has(t)) continue;
    const p = panes.find((q) => q.tabs.includes(NEIGHBOUR[t])) ?? panes[panes.length - 1]!;
    p.tabs.push(t);
  }
  const sum = panes.reduce((a, p) => a + p.ratio, 0) || 1;
  for (const p of panes) p.ratio = p.ratio / sum;
  return {
    recordWidth: num(raw?.recordWidth, d.recordWidth, 200, 900),
    bottomHeight: num(raw?.bottomHeight, d.bottomHeight, 100, 2000),
    panes,
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const s = await getStore();
    if (s) return merge(await s.get<Partial<Settings>>(KEY));
    const raw = localStorage.getItem(KEY);
    return merge(raw ? (JSON.parse(raw) as Partial<Settings>) : null);
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const s = await getStore();
  if (s) {
    await s.set(KEY, settings);
    await s.save();
    return;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // プレビュー環境で保存できなくても動作は続ける
  }
}

/** 41 手目以降の既定エンジン */
export function normalEngine(s: Settings): EngineConfig | null {
  return s.engines.find((e) => e.id === s.normalEngineId && e.kind === 'normal') ?? s.engines.find((e) => e.kind === 'normal') ?? null;
}
