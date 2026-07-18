import { seedTournament } from './seed';

// Runs once before the whole suite: creates a fresh organizer + two players
// on their own single-player teams, a 2-hole live tournament, via the real
// RPCs against a local `supabase start` instance (not mocked) -- writes
// e2e/.seed.json for the spec to read.
export default async function globalSetup() {
  const seed = await seedTournament();
  console.log(`[e2e] seeded tournament ${seed.tournamentId}`);
}
