import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { createApi, type Api } from './api.ts';

export interface Settings {
  /** countbone server, e.g. http://192.168.1.20:8000 */
  serverUrl: string;
  /** Name recorded against review decisions in the audit trail. */
  reviewer: string;
  haptics: boolean;
  grid: boolean;
  outlines: boolean;
  stats: boolean;
  /** Off by default: audio is never needed to count, and it is a privacy cost. */
  audio: boolean;
}

const KEY = 'countbone.settings.v1';
const API_PORT = 8000;

/**
 * Where the server most likely is before anyone has typed an address.
 * Web: the host serving the page. Native dev build: the machine running
 * Metro, since that is where `countbone serve` usually runs too.
 */
function guessServerUrl(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.hostname) {
    return `${window.location.protocol === 'https:' ? 'https' : 'http'}://${window.location.hostname}:${API_PORT}`;
  }
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host || '127.0.0.1'}:${API_PORT}`;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: guessServerUrl(),
  reviewer: 'mobile',
  haptics: true,
  grid: true,
  outlines: true,
  stats: true,
  audio: false,
};

/** Accepts "192.168.1.20:8000" or a full URL; returns null if unusable. */
export function normaliseServerUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function sanitise(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.serverUrl === 'string') out.serverUrl = normaliseServerUrl(r.serverUrl) ?? out.serverUrl;
  if (typeof r.reviewer === 'string' && r.reviewer.trim()) out.reviewer = r.reviewer.trim().slice(0, 60);
  for (const k of ['haptics', 'grid', 'outlines', 'stats', 'audio'] as const) {
    if (typeof r[k] === 'boolean') out[k] = r[k];
  }
  return out;
}

interface SettingsContextValue {
  settings: Settings;
  loaded: boolean;
  update: (patch: Partial<Settings>) => void;
  api: Api;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(KEY)
      .then((text) => {
        if (!cancelled && text) setSettings(sanitise(JSON.parse(text)));
      })
      .catch((err: unknown) => console.warn('settings: could not load, using defaults', err))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = sanitise({ ...prev, ...patch });
      AsyncStorage.setItem(KEY, JSON.stringify(next)).catch((err: unknown) =>
        console.warn('settings: could not save', err),
      );
      return next;
    });
  }, []);

  const api = useMemo(() => createApi(settings.serverUrl), [settings.serverUrl]);
  const value = useMemo(() => ({ settings, loaded, update, api }), [settings, loaded, update, api]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>');
  return ctx;
}
