// 設定の保存。Tauri では plugin-store（アプリのデータフォルダの settings.json）、
// ブラウザのプレビューでは localStorage に落とす。中身の形は同じ。

import { isTauri, type EngineConfig } from './usi/engine.ts';

export interface Settings {
  engines: EngineConfig[];
  theme: 'system' | 'light' | 'dark';
  /** 評価値→勝率の換算。既定は 41 手目局面の実測較正（S=435, +34cp） */
  winrate: { scale: number; offsetCp: number };
  /** 検討で使うエンジン id */
  analysisEngineId?: string;
}

export function defaultSettings(): Settings {
  return { engines: [], theme: 'system', winrate: { scale: 435, offsetCp: 34 } };
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

function merge(saved: Partial<Settings> | null | undefined): Settings {
  const d = defaultSettings();
  if (!saved) return d;
  return {
    ...d,
    ...saved,
    engines: Array.isArray(saved.engines) ? saved.engines : [],
    winrate: { ...d.winrate, ...(saved.winrate ?? {}) },
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
