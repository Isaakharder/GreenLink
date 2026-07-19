import { useEffect, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabaseClient';
import { initConnectionMonitor } from '../lib/sync';
import { initChatSyncMonitor } from '../lib/chatSync';
import { AuthContext, type AuthContextValue } from './context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthContextValue['session']>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!isMounted) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setLoading(false);
    });

    initConnectionMonitor();
    initChatSyncMonitor();

    return () => {
      isMounted = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    loading,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
