/**
 * Who is signed in, to which server, and what the next recording is for.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, getServer, hydrate, onSignedOut, setServer, type Principal } from '@/api/client';
import { setQueueUser, startQueue, type Target } from '@/api/uploadQueue';

interface Session {
  ready: boolean;
  user: Principal | null;
  server: string;
  signIn: (server: string, username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** What the next recording will be filed under. */
  target: Target;
  setTarget: (t: Target) => void;
}

export const EMPTY_TARGET: Target = {
  kind: 'count',
  location: null,
  receipt_id: null,
  task_id: null,
  walk_id: null,
  job_id: null,
  title: 'Cycle count',
};

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<Principal | null>(null);
  const [server, setServerState] = useState(getServer());
  const [target, setTarget] = useState<Target>(EMPTY_TARGET);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { server: s, token } = await hydrate();
      if (!alive) return;
      setServerState(s);
      if (token) {
        try {
          const me = await api.me();
          setUser(me);
          await setQueueUser({ id: me.user_id, name: me.display_name });
        } catch {
          // Offline at launch: keep the token and let the queue retry. The
          // screens that need the server say so; recording still works.
          setUser(null);
        }
      }
      setReady(true);
      startQueue();
    })();
    const off = onSignedOut(() => setUser(null));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const signIn = useCallback(async (url: string, username: string, password: string) => {
    await setServer(url);
    setServerState(getServer());
    const me = await api.login(username, password);
    setUser(me);
    await setQueueUser({ id: me.user_id, name: me.display_name });
    startQueue();
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
    // Recordings stay on the phone for their filmer; the next person to sign
    // in does not upload them as their own.
    await setQueueUser(null);
  }, []);

  const value = useMemo(
    () => ({ ready, user, server, signIn, signOut, target, setTarget }),
    [ready, user, server, signIn, signOut, target],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
