import { createContext } from 'react';
import type { Session, User } from '@supabase/supabase-js';

export interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  // True from the moment Supabase's PASSWORD_RECOVERY event fires (the user
  // clicked a password-reset email link) until completePasswordRecovery() is
  // called. A recovery session must never be treated as an ordinary login --
  // see resolveRootRouteOutcome / resolveProtectedRouteOutcome.
  isPasswordRecovery: boolean;
  completePasswordRecovery: () => void;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
