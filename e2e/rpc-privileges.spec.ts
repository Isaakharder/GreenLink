import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Security regression suite for supabase/migrations/0036 (RPC privilege
// lockdown). Exercises the real Postgres/PostgREST privilege layer directly
// via supabase-js -- these are permission-layer checks, not UI flows, so
// there's no `page` involved (mirrors the "Avatar storage security" block
// in avatar-profile.spec.ts, which does the same for Storage). The rest of
// the Playwright suite (course-library, invite-members, tournament-chat,
// live-scoring, personal-round-flow, member-directory, etc.) already proves
// every legitimate authenticated flow still works end-to-end through the
// UI; this file is only about what an unauthenticated or wrongly-scoped
// caller can and cannot do at the database layer.

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function anon(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

interface SeededUser {
  id: string;
  email: string;
  password: string;
}

async function seedUser(tag: string): Promise<SeededUser> {
  const stamp = Date.now() + Math.floor(Math.random() * 10000);
  const email = `e2e-rpcpriv-${tag}-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Priv', last_name: `Test${stamp}`, username: `e2e_rpcpriv_${tag}_${stamp}` },
  });
  if (error) throw error;
  return { id: data.user!.id, email, password };
}

async function signedInClient(user: SeededUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw error;
  return client;
}

test.describe('Deliberately anonymous RPC continues to work', () => {
  test('anonymous is_username_available succeeds', async () => {
    const { data, error } = await anon().rpc('is_username_available', { p_username: `nobody-${Date.now()}` });
    expect(error).toBeNull();
    expect(typeof data).toBe('boolean');
  });
});

test.describe('Anonymous calls are refused at the privilege layer', () => {
  test('anonymous list_members fails', async () => {
    const { error } = await anon().rpc('list_members');
    expect(error).not.toBeNull();
  });

  test('anonymous get_public_round_feed fails', async () => {
    const { error } = await anon().rpc('get_public_round_feed', { p_limit: 5 });
    expect(error).not.toBeNull();
  });

  test('anonymous search_profile_by_username fails', async () => {
    const { error } = await anon().rpc('search_profile_by_username', { p_username: 'whoever' });
    expect(error).not.toBeNull();
  });

  test('anonymous tournament/scoring/chat RPCs fail at the privilege layer', async () => {
    const createResult = await anon().rpc('create_tournament', {
      p_name: 'Anon Tournament',
      p_course_name: 'Nowhere',
      p_tournament_date: new Date().toISOString().slice(0, 10),
    });
    expect(createResult.error).not.toBeNull();

    const scoreResult = await anon().rpc('submit_team_score', {
      p_operation_uuid: '00000000-0000-0000-0000-000000000000',
      p_tournament_id: '00000000-0000-0000-0000-000000000000',
      p_team_id: '00000000-0000-0000-0000-000000000000',
      p_hole_number: 1,
      p_new_strokes: 4,
    });
    expect(scoreResult.error).not.toBeNull();

    const chatResult = await anon().rpc('send_tournament_message', {
      p_tournament_id: '00000000-0000-0000-0000-000000000000',
      p_operation_uuid: '00000000-0000-0000-0000-000000000000',
      p_message_text: 'hello',
    });
    expect(chatResult.error).not.toBeNull();
  });

  test('anonymous insert_manual_course_tee fails', async () => {
    const { error } = await anon().rpc('insert_manual_course_tee', {
      p_course_id: '00000000-0000-0000-0000-000000000000',
      p_tee: {},
    });
    expect(error).not.toBeNull();
  });
});

test.describe('Internal-only helpers refuse a direct caller even when authenticated', () => {
  test('authenticated direct insert_manual_course_tee fails', async () => {
    const user = await seedUser('insert-tee-direct');
    const client = await signedInClient(user);
    const { error } = await client.rpc('insert_manual_course_tee', {
      p_course_id: '00000000-0000-0000-0000-000000000000',
      p_tee: { tee_name: 'Blue', gender: 'male', holes: [] },
    });
    expect(error).not.toBeNull();
  });

  test('authenticated direct validate_manual_tee fails', async () => {
    const user = await seedUser('validate-tee-direct');
    const client = await signedInClient(user);
    const { error } = await client.rpc('validate_manual_tee', {
      p_tee: { tee_name: 'Blue', gender: 'male', holes: [] },
      p_require_complete: false,
    });
    expect(error).not.toBeNull();
  });
});

test.describe('Authenticated members retain exactly the access they need', () => {
  test('authenticated list_members succeeds', async () => {
    const user = await seedUser('list-members');
    const client = await signedInClient(user);
    const { error } = await client.rpc('list_members');
    expect(error).toBeNull();
  });

  test('authenticated Community Feed succeeds', async () => {
    const user = await seedUser('feed');
    const client = await signedInClient(user);
    const { error } = await client.rpc('get_public_round_feed', { p_limit: 5 });
    expect(error).toBeNull();
  });

  test('authenticated course search still works as intended', async () => {
    const user = await seedUser('search-courses');
    const client = await signedInClient(user);
    const { error } = await client.rpc('search_courses', { p_query: 'anything', p_limit: 5 });
    expect(error).toBeNull();
  });

  test('create_manual_course can still internally create tees', async () => {
    const user = await seedUser('create-course');
    const client = await signedInClient(user);
    const { data: courseId, error } = await client.rpc('create_manual_course', {
      p_club_name: `E2E RPC Priv Club ${Date.now()}`,
      p_course_name: 'Test Course',
      p_tees: [
        {
          tee_name: 'Blue',
          gender: 'male',
          holes: Array.from({ length: 9 }, (_, i) => ({ hole_number: i + 1, par: 4 })),
        },
      ],
      p_publish: true,
    });
    expect(error).toBeNull();
    expect(courseId).toBeTruthy();

    const { data: tees, error: teesError } = await admin()
      .from('golf_course_tees')
      .select('id, tee_name')
      .eq('golf_course_id', courseId as string);
    expect(teesError).toBeNull();
    expect(tees).toHaveLength(1);
    expect(tees?.[0].tee_name).toBe('Blue');
  });

  test('replace_manual_course_tees can still internally replace tees', async () => {
    const user = await seedUser('replace-tees');
    const client = await signedInClient(user);
    const { data: courseId, error: createError } = await client.rpc('create_manual_course', {
      p_club_name: `E2E RPC Priv Replace ${Date.now()}`,
      p_course_name: 'Test Course',
      p_tees: [
        {
          tee_name: 'Blue',
          gender: 'male',
          holes: Array.from({ length: 9 }, (_, i) => ({ hole_number: i + 1, par: 4 })),
        },
      ],
      p_publish: true,
    });
    expect(createError).toBeNull();

    const { error: replaceError } = await client.rpc('replace_manual_course_tees', {
      p_course_id: courseId as string,
      p_tees: [
        {
          tee_name: 'Red',
          gender: 'female',
          holes: Array.from({ length: 9 }, (_, i) => ({ hole_number: i + 1, par: 4 })),
        },
      ],
      p_publish: true,
    });
    expect(replaceError).toBeNull();

    const { data: tees, error: teesError } = await admin()
      .from('golf_course_tees')
      .select('tee_name')
      .eq('golf_course_id', courseId as string)
      .is('archived_at', null);
    expect(teesError).toBeNull();
    expect(tees).toHaveLength(1);
    expect(tees?.[0].tee_name).toBe('Red');
  });
});

test.describe('Non-organizers/non-members still cannot perform privileged actions', () => {
  test('a non-organizer cannot start or finish someone else\'s tournament', async () => {
    const organizer = await seedUser('organizer');
    const outsider = await seedUser('outsider');
    const organizerClient = await signedInClient(organizer);
    const outsiderClient = await signedInClient(outsider);

    const { data: tournamentId, error: createError } = await organizerClient.rpc('create_tournament', {
      p_name: `E2E Ownership ${Date.now()}`,
      p_course_name: 'Test Course',
      p_tournament_date: new Date().toISOString().slice(0, 10),
    });
    expect(createError).toBeNull();

    const startResult = await outsiderClient.rpc('start_tournament', { p_tournament_id: tournamentId });
    expect(startResult.error).not.toBeNull();

    const finishResult = await outsiderClient.rpc('finish_tournament', { p_tournament_id: tournamentId });
    expect(finishResult.error).not.toBeNull();

    const inviteResult = await outsiderClient.rpc('invite_player', {
      p_tournament_id: tournamentId,
      p_invited_user_id: organizer.id,
    });
    expect(inviteResult.error).not.toBeNull();
  });
});

test.describe('Service-role paths (used by golf-course-lookup) remain functional', () => {
  test('service_role can still call search_courses directly', async () => {
    const { error } = await admin().rpc('search_courses', { p_query: 'anything', p_limit: 5 });
    expect(error).toBeNull();
  });
});
