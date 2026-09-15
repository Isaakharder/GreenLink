import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { useAuth } from './auth/useAuth';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { resolveRootRouteOutcome } from './auth/routing';
import { AppShell } from './components/AppShell';
import { LoggedOutHome } from './pages/LoggedOutHome';
import { SignIn } from './pages/SignIn';
import { SignUp } from './pages/SignUp';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { Home } from './pages/Home';
import { Members } from './pages/Members';
import { Profile } from './pages/Profile';
import { Settings } from './pages/settings/Settings';
import { CourseLibrary } from './pages/settings/CourseLibrary';
import { CourseForm } from './pages/settings/CourseForm';
import { MyGolf } from './pages/MyGolf';
import { StartRound } from './pages/myGolf/StartRound';
import { PersonalRoundShell } from './pages/myGolf/PersonalRoundShell';
import { TournamentsPage } from './pages/tournaments/TournamentsPage';
import { CreateTournament } from './pages/tournaments/CreateTournament';
import { TournamentDetail } from './pages/tournament/TournamentDetail';
import { OverviewTab } from './pages/tournament/OverviewTab';
import { TeamsTab } from './pages/tournament/TeamsTab';
import { ScorecardTab } from './pages/tournament/ScorecardTab';
import { LiveScoreTab } from './pages/tournament/LiveScoreTab';
import { SettingsTab } from './pages/tournament/SettingsTab';

function RootRoute() {
  const { session, loading, isPasswordRecovery } = useAuth();
  const outcome = resolveRootRouteOutcome({ loading, hasSession: !!session, isPasswordRecovery });

  switch (outcome) {
    case 'loading':
      return <div className="page-status">Loading…</div>;
    // A password-recovery link can land here (e.g. via the wildcard route
    // below, or a redirect URL mismatch) with a session already established
    // -- that must not be treated as a normal login and sent to /home before
    // the user has actually set a new password.
    case 'recovery':
      return <Navigate to="/reset-password" replace />;
    case 'home':
      return <Navigate to="/home" replace />;
    case 'logged-out':
      return <LoggedOutHome />;
  }
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<RootRoute />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/sign-up" element={<SignUp />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<AppShell />}>
              <Route path="/home" element={<Home />} />
              <Route path="/members" element={<Members />} />
              <Route path="/my-golf" element={<MyGolf />} />
              <Route path="/my-golf/start" element={<StartRound />} />
              <Route path="/my-golf/round/:tournamentId" element={<PersonalRoundShell />}>
                <Route index element={<ScorecardTab />} />
              </Route>
              <Route path="/profile" element={<Profile />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/courses" element={<CourseLibrary />} />
              <Route path="/settings/courses/new" element={<CourseForm />} />
              <Route path="/settings/courses/:courseId/edit" element={<CourseForm />} />

              <Route path="/tournaments" element={<TournamentsPage />} />
              <Route path="/tournaments/new" element={<CreateTournament />} />

              <Route path="/tournaments/:tournamentId" element={<TournamentDetail />}>
                <Route index element={<Navigate to="overview" replace />} />
                <Route path="overview" element={<OverviewTab />} />
                <Route path="teams" element={<TeamsTab />} />
                <Route path="scorecard" element={<ScorecardTab />} />
                <Route path="live" element={<LiveScoreTab />} />
                <Route path="settings" element={<SettingsTab />} />
              </Route>
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
