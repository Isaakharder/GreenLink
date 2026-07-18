import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Local-only: these must point at a `supabase start` instance, never a real
// project. The service-role key is required to create pre-confirmed test
// users without an email round-trip; it is read from the environment
// (printed by `supabase start`) rather than hardcoded, since it's
// regenerated per local stack and must never be a real project's secret.
const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;

const OUTPUT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '.seed.json');

interface SeededUser {
  email: string;
  password: string;
}

export interface SeedResult {
  tournamentId: string;
  playerA: SeededUser;
  playerB: SeededUser;
}

async function createConfirmedUser(
  admin: SupabaseClient,
  email: string,
  password: string,
  firstName: string,
  lastName: string,
  username: string,
): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: firstName, last_name: lastName, username },
  });
  if (error) throw error;
  return data.user!.id;
}

export async function seedTournament(): Promise<SeedResult> {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      'E2E_SUPABASE_ANON_KEY / E2E_SUPABASE_SERVICE_ROLE_KEY must be set (values printed by `supabase start`).',
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const stamp = Date.now();
  const organizer = { email: `e2e-organizer-${stamp}@example.test`, password: 'e2e-password-123' };
  const playerA = { email: `e2e-player-a-${stamp}@example.test`, password: 'e2e-password-123' };
  const playerB = { email: `e2e-player-b-${stamp}@example.test`, password: 'e2e-password-123' };

  await createConfirmedUser(admin, organizer.email, organizer.password, 'Ollie', 'Organizer', `e2e_org_${stamp}`);
  const playerAId = await createConfirmedUser(admin, playerA.email, playerA.password, 'Ana', 'PlayerA', `e2e_a_${stamp}`);
  const playerBId = await createConfirmedUser(admin, playerB.email, playerB.password, 'Ben', 'PlayerB', `e2e_b_${stamp}`);

  const organizerClient = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await organizerClient.auth.signInWithPassword(organizer);
  if (signInError) throw signInError;

  const { data: tournamentId, error: createError } = await organizerClient.rpc('create_tournament', {
    p_name: `E2E Live Scoring ${stamp}`,
    p_course_name: 'E2E Test Course',
    p_tournament_date: new Date().toISOString().slice(0, 10),
    p_hole_count: 2,
    p_scoring_format: 'Team Scramble',
    p_team_size: 1,
  });
  if (createError) throw createError;

  const { data: invA, error: invAError } = await organizerClient.rpc('invite_player', {
    p_tournament_id: tournamentId,
    p_invited_user_id: playerAId,
  });
  if (invAError) throw invAError;
  const { data: invB, error: invBError } = await organizerClient.rpc('invite_player', {
    p_tournament_id: tournamentId,
    p_invited_user_id: playerBId,
  });
  if (invBError) throw invBError;

  const aClient = createClient(SUPABASE_URL, ANON_KEY);
  await aClient.auth.signInWithPassword(playerA);
  const { error: acceptAError } = await aClient.rpc('accept_invitation', { p_invitation_id: invA });
  if (acceptAError) throw acceptAError;

  const bClient = createClient(SUPABASE_URL, ANON_KEY);
  await bClient.auth.signInWithPassword(playerB);
  const { error: acceptBError } = await bClient.rpc('accept_invitation', { p_invitation_id: invB });
  if (acceptBError) throw acceptBError;

  const { data: teamOrganizer, error: teamOrgError } = await organizerClient.rpc('create_tournament_team', {
    p_tournament_id: tournamentId,
    p_name: 'Team Organizer',
  });
  if (teamOrgError) throw teamOrgError;
  const { data: teamA, error: teamAError } = await organizerClient.rpc('create_tournament_team', {
    p_tournament_id: tournamentId,
    p_name: 'Team A',
  });
  if (teamAError) throw teamAError;
  const { data: teamB, error: teamBError } = await organizerClient.rpc('create_tournament_team', {
    p_tournament_id: tournamentId,
    p_name: 'Team B',
  });
  if (teamBError) throw teamBError;

  const { data: players, error: playersError } = await organizerClient
    .from('tournament_players')
    .select('id, user_id')
    .eq('tournament_id', tournamentId);
  if (playersError) throw playersError;

  const organizerPlayerId = players!.find((p) => p.user_id !== playerAId && p.user_id !== playerBId)!.id;
  const playerAPlayerId = players!.find((p) => p.user_id === playerAId)!.id;
  const playerBPlayerId = players!.find((p) => p.user_id === playerBId)!.id;

  for (const [playerId, teamId] of [
    [organizerPlayerId, teamOrganizer.id],
    [playerAPlayerId, teamA.id],
    [playerBPlayerId, teamB.id],
  ]) {
    const { error } = await organizerClient.rpc('assign_tournament_player', {
      p_player_id: playerId,
      p_team_id: teamId,
    });
    if (error) throw error;
  }

  const { error: holesError } = await organizerClient.rpc('save_tournament_holes', {
    p_tournament_id: tournamentId,
    p_holes: [
      { hole_number: 1, par: 4 },
      { hole_number: 2, par: 3 },
    ],
  });
  if (holesError) throw holesError;

  const { error: startError } = await organizerClient.rpc('start_tournament', { p_tournament_id: tournamentId });
  if (startError) throw startError;

  const result: SeedResult = { tournamentId, playerA, playerB };
  writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  return result;
}

export function readSeed(): SeedResult {
  return JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8')) as SeedResult;
}

export interface SeededGolfCourse {
  externalId: string;
  clubName: string;
  courseName: string;
  city: string;
  state: string;
  country: string;
  teeId: string;
  teeName: string;
  numberOfHoles: number;
  parTotal: number;
  courseRating: number;
  slopeRating: number;
}

/**
 * Seeds a golf_courses/golf_course_tees/golf_course_tee_holes fixture
 * directly (service-role insert, same technique the pgTAP fixtures use) --
 * this is the data a *real* Edge Function import would have cached. Tests
 * that need to exercise apply_imported_course_to_tournament() for real
 * (without depending on a live GolfCourseAPI key) mock only the Edge
 * Function's HTTP responses (via page.route()) to reference this fixture's
 * externalId/teeId, so the RPC call itself still operates on genuine rows.
 */
export async function seedGolfCourseFixture(organizerUserId: string): Promise<SeededGolfCourse> {
  if (!SERVICE_ROLE_KEY) throw new Error('E2E_SUPABASE_SERVICE_ROLE_KEY must be set.');
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const stamp = Date.now();
  const externalId = `e2e-course-${stamp}`;
  const clubName = 'E2E Fixture Golf Club';
  const courseName = 'E2E Fixture Course';

  const { data: course, error: courseError } = await admin
    .from('golf_courses')
    .insert({
      external_id: externalId,
      club_name: clubName,
      course_name: courseName,
      city: 'Testville',
      state: 'NC',
      country: 'USA',
      imported_by: organizerUserId,
      raw_payload: {},
    })
    .select('id')
    .single();
  if (courseError) throw courseError;

  const { data: tee, error: teeError } = await admin
    .from('golf_course_tees')
    .insert({
      golf_course_id: course.id,
      tee_name: 'Blue',
      gender: 'male',
      number_of_holes: 18,
      par_total: 72,
      course_rating: 71.4,
      slope_rating: 128,
    })
    .select('id')
    .single();
  if (teeError) throw teeError;

  const pars = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
  const holeRows = Array.from({ length: 18 }, (_, i) => ({
    tee_id: tee.id,
    hole_number: i + 1,
    par: pars[i],
    yardage: 350 + i * 5,
    handicap: ((i * 7) % 18) + 1,
  }));
  const { error: holesError } = await admin.from('golf_course_tee_holes').insert(holeRows);
  if (holesError) throw holesError;

  return {
    externalId,
    clubName,
    courseName,
    city: 'Testville',
    state: 'NC',
    country: 'USA',
    teeId: tee.id,
    teeName: 'Blue',
    numberOfHoles: 18,
    parTotal: 72,
    courseRating: 71.4,
    slopeRating: 128,
  };
}
