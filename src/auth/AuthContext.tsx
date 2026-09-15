import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabaseClient';
import { initConnectionMonitor } from '../lib/sync';
import { initChatSyncMonitor } from '../lib/chatSync';
import { AuthContext, type AuthContextValue } from './context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthContextValue['session']>(null);
  const [loading, setLoading] = useState(true);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);

  useEffect(() => {
    let isMounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!isMounted) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((event, newSession) => {
      // Fired when the user clicks a password-reset email link. Must be
      // tracked separately from `session` -- the recovery session Supabase
      // establishes is otherwise indistinguishable from a normal sign-in,
      // which would let RootRoute/ProtectedRoute wave the user straight
      // into the app without ever changing their password.
      if (event === 'PASSWORD_RECOVERY') {
        setIsPasswordRecovery(true);
      } else if (event === 'SIGNED_OUT') {
        setIsPasswordRecovery(false);
      }
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

  const completePasswordRecovery = useCallback(() => {
    setIsPasswordRecovery(false);
  }, []);

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    loading,
    isPasswordRecovery,
    completePasswordRecovery,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
