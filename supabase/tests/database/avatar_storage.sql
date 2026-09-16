-- ============================================================================
-- pgTAP suite for the avatar feature's database-level pieces
-- (supabase/migrations/0035): the profiles.photo_path ownership CHECK
-- constraint, and the list_members()/get_public_round_feed() column
-- additions. Storage RLS itself (upload/replace/delete own vs. another
-- user's object, authenticated read, anonymous denial) is exercised
-- end-to-end against the real Storage API in
-- e2e/avatar-profile.spec.ts instead of simulated here via raw SQL against
-- storage.objects -- the Storage API does its own validation beyond pure
-- RLS (MIME type, size), so a real client call is the more faithful test
-- of what a user can actually do.
--
-- Run with: supabase test db
-- ============================================================================

begin;

create extension if not exists pgtap;
create extension if not exists pgcrypto;

select plan(10);

-- Same expect_exception() helper as tournament_setup_rules.sql -- avoids
-- guessing pgTAP's throws_ok() overload/error-code matching.
create function pg_temp.expect_exception(p_sql text) returns boolean
language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: two members.
-- ---------------------------------------------------------------------------

do $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', '70000000-0000-0000-0000-000000000001',
     'authenticated', 'authenticated', 'avatar-a@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Ada', 'last_name', 'Avatar', 'username', 'avatar_a_test'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '70000000-0000-0000-0000-000000000002',
     'authenticated', 'authenticated', 'avatar-b@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Ben', 'last_name', 'Bavatar', 'username', 'avatar_b_test'),
     now(), now(), '', '', '', '');
end $$;

-- ---------------------------------------------------------------------------
-- 1) profiles.photo_path ownership CHECK constraint.
-- ---------------------------------------------------------------------------

select ok(
  not pg_temp.expect_exception(format(
    'update public.profiles set photo_path = %L where id = %L',
    '70000000-0000-0000-0000-000000000001/avatar.webp', '70000000-0000-0000-0000-000000000001'
  )),
  'a profile can set photo_path to its own {id}/avatar.webp path'
);

select ok(
  not pg_temp.expect_exception(format(
    'update public.profiles set photo_path = null where id = %L', '70000000-0000-0000-0000-000000000001'
  )),
  'a profile can clear photo_path back to null'
);

select ok(
  pg_temp.expect_exception(format(
    'update public.profiles set photo_path = %L where id = %L',
    '70000000-0000-0000-0000-000000000002/avatar.webp', '70000000-0000-0000-0000-000000000001'
  )),
  'a profile cannot set photo_path to point inside another user''s folder'
);

select ok(
  pg_temp.expect_exception(format(
    'update public.profiles set photo_path = %L where id = %L', 'not-even-a-path', '70000000-0000-0000-0000-000000000001'
  )),
  'a profile cannot set photo_path to an arbitrary string'
);

-- ---------------------------------------------------------------------------
-- 2) list_members(): photo_path is returned and reflects the real value.
-- ---------------------------------------------------------------------------

do $$
begin
  update public.profiles set photo_path = '70000000-0000-0000-0000-000000000001/avatar.webp' where id = '70000000-0000-0000-0000-000000000001';

  perform set_config('request.jwt.claims',
    json_build_object('sub', '70000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select photo_path from public.list_members() where id = '70000000-0000-0000-0000-000000000001'::uuid),
  '70000000-0000-0000-0000-000000000001/avatar.webp',
  'list_members() returns the real photo_path for a member who has one'
);
select is(
  (select photo_path from public.list_members() where id = '70000000-0000-0000-0000-000000000002'::uuid),
  null::text,
  'list_members() returns null photo_path for a member with no avatar'
);

select ok(
  (select count(*) = 7 from information_schema.parameters where specific_schema = 'public' and specific_name in (
    select specific_name from information_schema.routines where routine_schema = 'public' and routine_name = 'list_members'
  ) and parameter_mode = 'OUT'),
  'list_members() returns exactly 7 output columns -- id, first_name, last_name, username, photo_path, completed_rounds_count, member_since'
);

select ok(
  not exists (
    select 1 from information_schema.parameters where specific_schema = 'public' and specific_name in (
      select specific_name from information_schema.routines where routine_schema = 'public' and routine_name = 'list_members'
    ) and parameter_mode = 'OUT' and parameter_name = 'email'
  ),
  'list_members() still never returns an email column'
);

reset role;

-- ---------------------------------------------------------------------------
-- 3) get_public_round_feed(): player_id/player_photo_path are returned.
-- ---------------------------------------------------------------------------

do $$
declare
  v_tournament_id uuid;
begin
  insert into public.tournaments (id, organizer_user_id, name, course_name, tournament_date, status, is_personal)
  values ('71000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 'Avatar Feed Round', 'Test Course', current_date, 'completed', true)
  returning id into v_tournament_id;

  insert into public.personal_rounds (tournament_id, visibility, walking_or_cart)
  values (v_tournament_id, 'public', 'walking');
end $$;

select is(
  (select player_id from public.get_public_round_feed() where tournament_id = '71000000-0000-0000-0000-000000000001'::uuid),
  '70000000-0000-0000-0000-000000000001'::uuid,
  'get_public_round_feed() returns the player''s id'
);
select is(
  (select player_photo_path from public.get_public_round_feed() where tournament_id = '71000000-0000-0000-0000-000000000001'::uuid),
  '70000000-0000-0000-0000-000000000001/avatar.webp',
  'get_public_round_feed() returns the player''s photo_path'
);

select * from finish();
rollback;
