-- ============================================================================
-- pgTAP suite for the member directory (supabase/migrations/0032, 0033,
-- 0034). Covers: list_members() returns every profile with the correct
-- completed_rounds_count -- counting only 'accepted' tournament_players rows
-- joined to a 'completed' tournament, excluding 'removed' memberships and
-- non-completed tournaments (draft/upcoming/live/cancelled), counting a
-- personal round (is_personal = true) exactly like a real tournament -- plus
-- the correct member_since (the profile's own created_at) and username
-- (0034 -- added so the Teams tab can discover/invite members without a
-- username-search round trip), and never returning email or any other
-- profiles column beyond id/first_name/last_name/username/member_since.
-- Same fixture/impersonation pattern as manual_course_library.sql /
-- personal_rounds.sql. Creates its own throwaway users/tournaments and rolls
-- back at the end.
--
-- Run with: supabase test db
-- ============================================================================

begin;

create extension if not exists pgtap;
create extension if not exists pgcrypto;

select plan(12);

create temp table fixtures (key text primary key, value text);

create function pg_temp.remember(p_key text, p_value text) returns void
language sql security definer as $$
  insert into fixtures (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value;
$$;

create function pg_temp.recall(p_key text) returns text
language sql stable security definer as $$
  select value from fixtures where key = p_key;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: three members.
--   A: two completed rounds (one real tournament, one personal round).
--   B: one completed round, plus a live (not-yet-completed) tournament that
--      must not count, plus removed membership on one of A's completed
--      tournaments that must not count for B either.
--   C: zero completed rounds (never in tournament_players at all).
-- ---------------------------------------------------------------------------

do $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', '60000000-0000-0000-0000-000000000001',
     'authenticated', 'authenticated', 'member-a@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Amy', 'last_name', 'Alpha', 'username', 'member_a_test'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '60000000-0000-0000-0000-000000000002',
     'authenticated', 'authenticated', 'member-b@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Beau', 'last_name', 'Bravo', 'username', 'member_b_test'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '60000000-0000-0000-0000-000000000003',
     'authenticated', 'authenticated', 'member-c@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Cleo', 'last_name', 'Charlie', 'username', 'member_c_test'),
     now(), now(), '', '', '', '');

  -- A's first completed round: a real (non-personal) tournament.
  insert into public.tournaments (id, organizer_user_id, name, course_name, tournament_date, status)
  values ('61000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'Completed Tournament 1', 'Test Course', current_date, 'completed');
  insert into public.tournament_players (tournament_id, user_id, membership_status, is_organizer)
  values ('61000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'accepted', true);

  -- A's second completed round: a personal round (is_personal = true) --
  -- must count exactly like a real tournament.
  insert into public.tournaments (id, organizer_user_id, name, course_name, tournament_date, status, is_personal)
  values ('61000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001', 'Completed Personal Round', 'Test Course', current_date, 'completed', true);
  insert into public.tournament_players (tournament_id, user_id, membership_status, is_organizer)
  values ('61000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001', 'accepted', true);

  -- B is also on A's first tournament, but removed -- must not count for B.
  insert into public.tournament_players (tournament_id, user_id, membership_status, is_organizer)
  values ('61000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002', 'removed', false);

  -- B's own completed round.
  insert into public.tournaments (id, organizer_user_id, name, course_name, tournament_date, status)
  values ('61000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000002', 'Completed Tournament 2', 'Test Course', current_date, 'completed');
  insert into public.tournament_players (tournament_id, user_id, membership_status, is_organizer)
  values ('61000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000002', 'accepted', true);

  -- B's live (not completed) tournament -- must not count.
  insert into public.tournaments (id, organizer_user_id, name, course_name, tournament_date, status, started_at)
  values ('61000000-0000-0000-0000-000000000004', '60000000-0000-0000-0000-000000000002', 'Live Tournament', 'Test Course', current_date, 'live', now());
  insert into public.tournament_players (tournament_id, user_id, membership_status, is_organizer)
  values ('61000000-0000-0000-0000-000000000004', '60000000-0000-0000-0000-000000000002', 'accepted', true);

  -- C: a profile that has never played anything.

  -- Captured now, as the table owner (before any `set local role
  -- authenticated` below) -- profiles' own RLS only allows selecting your
  -- own row, so reading member A's created_at while impersonating a
  -- different user later would return no row, not a comparable value.
  perform pg_temp.remember('member_a_created_at', (select created_at::text from public.profiles where id = '60000000-0000-0000-0000-000000000001'));
end $$;

-- ---------------------------------------------------------------------------
-- list_members() as an ordinary authenticated user (a directory of everyone,
-- not just the caller).
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '60000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  (select true from public.list_members() where id = '60000000-0000-0000-0000-000000000001'::uuid),
  'list_members() includes member A'
);
select ok(
  (select true from public.list_members() where id = '60000000-0000-0000-0000-000000000002'::uuid),
  'list_members() includes member B'
);
select ok(
  (select true from public.list_members() where id = '60000000-0000-0000-0000-000000000003'::uuid),
  'list_members() includes member C, who has never played a round'
);

select is(
  (select completed_rounds_count from public.list_members() where id = '60000000-0000-0000-0000-000000000001'::uuid),
  2,
  'member A has 2 completed rounds: one real tournament and one personal round, counted the same way'
);
select is(
  (select completed_rounds_count from public.list_members() where id = '60000000-0000-0000-0000-000000000002'::uuid),
  1,
  'member B has exactly 1 completed round -- the removed membership and the still-live tournament are both excluded'
);
select is(
  (select completed_rounds_count from public.list_members() where id = '60000000-0000-0000-0000-000000000003'::uuid),
  0,
  'member C, who has never joined a tournament, has 0 completed rounds -- never null'
);

select is(
  (select first_name from public.list_members() where id = '60000000-0000-0000-0000-000000000001'::uuid),
  'Amy',
  'first_name is returned'
);
select is(
  (select last_name from public.list_members() where id = '60000000-0000-0000-0000-000000000001'::uuid),
  'Alpha',
  'last_name is returned'
);

select is(
  (select username from public.list_members() where id = '60000000-0000-0000-0000-000000000001'::uuid),
  'member_a_test',
  'username is returned -- not a new privacy exposure, already searchable via search_profile_by_username()'
);

select is(
  (select member_since::text from public.list_members() where id = '60000000-0000-0000-0000-000000000001'::uuid),
  pg_temp.recall('member_a_created_at'),
  'member_since matches the profile''s own created_at (sign-up date)'
);

-- No email/username/is_admin/photo_path column exists on the return type at
-- all -- proven structurally (a function's RETURNS TABLE is a fixed column
-- list, not just "whatever the query includes"), not just by omission from a
-- SELECT the RPC happens to run today.
select ok(
  (select count(*) = 6 from information_schema.parameters where specific_schema = 'public' and specific_name in (
    select specific_name from information_schema.routines where routine_schema = 'public' and routine_name = 'list_members'
  ) and parameter_mode = 'OUT'),
  'list_members() returns exactly 6 output columns -- id, first_name, last_name, username, completed_rounds_count, member_since'
);

select ok(
  not exists (
    select 1 from information_schema.parameters where specific_schema = 'public' and specific_name in (
      select specific_name from information_schema.routines where routine_schema = 'public' and routine_name = 'list_members'
    ) and parameter_mode = 'OUT' and parameter_name = 'email'
  ),
  'list_members() never returns an email column'
);

reset role;

select * from finish();
rollback;
