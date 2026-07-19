import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { useAuth } from './auth/useAuth';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AppShell } from './components/AppShell';
import { LoggedOutHome } from './pages/LoggedOutHome';
import { SignIn } from './pages/SignIn';
import { SignUp } from './pages/SignUp';
import { Home } from './pages/Home';
import { Profile } from './pages/Profile';
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
  const { session, loading } = useAuth();

  if (loading) {
    return <div className="page-status">Loading…</div>;
  }

  if (session) {
    return <Navigate to="/home" replace />;
  }

  return <LoggedOutHome />;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<RootRoute />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/sign-up" element={<SignUp />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<AppShell />}>
              <Route path="/home" element={<Home />} />
              <Route path="/my-golf" element={<MyGolf />} />
              <Route path="/my-golf/start" element={<StartRound />} />
              <Route path="/my-golf/round/:tournamentId" element={<PersonalRoundShell />}>
                <Route index element={<ScorecardTab />} />
              </Route>
              <Route path="/profile" element={<Profile />} />

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
