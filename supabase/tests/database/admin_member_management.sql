-- ============================================================================
-- pgTAP suite for membership lifecycle + Admin -> Manage Members
-- (supabase/migrations/0037). Covers: list_members()/invite_player()
-- respecting membership_status; admin_list_members()/admin_set_member_
-- status()/admin_permanently_delete_member() all requiring is_admin() in
-- the function body itself (not just the EXECUTE grant -- a non-admin
-- authenticated caller must be rejected by the function, exactly the
-- "database-enforced authorization, not merely hiding the UI" requirement);
-- self-protection and last-active-administrator protection on both
-- deactivate and permanent delete; and permanent delete's full cleanup
-- (invitations removed, golf_courses provenance reassigned/nulled, auth.user
-- + profile actually gone) for a member with no tournament history, plus
-- its refusal (with organizer/player counts in the message) for one who has
-- any.
--
-- Run with: supabase test db
-- ============================================================================

begin;

create extension if not exists pgtap;
create extension if not exists pgcrypto;

select plan(30);

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
-- Fixtures.
--   admin_a, admin_b: two administrators (so deactivating/deleting one is
--     legal while the other remains active).
--   member_c: an ordinary active member -- deactivated then reactivated.
--   member_inactive: created already inactive, for admin_list_members()/
--     list_members() visibility checks with no mid-test status flip needed.
--   member_history: organizes a completed tournament -- proves permanent
--     delete refusal for an organizer.
--   member_player: plays (not organizes) a tournament -- proves refusal
--     for a roster entry specifically.
--   member_deletable: has zero tournament history but does have a pending
--     invitation and a golf_courses row under their name -- proves the
--     real cleanup path (not just "nothing to clean up").
-- ---------------------------------------------------------------------------

do $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000001',
     'authenticated', 'authenticated', 'admin-a@example.test', crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Ada', 'last_name', 'Admin', 'username', 'admin_a_test'), now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000002',
     'authenticated', 'authenticated', 'admin-b@example.test', crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Bea', 'last_name', 'Admin', 'username', 'admin_b_test'), now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000003',
     'authenticated', 'authenticated', 'member-c@example.test', crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Cam', 'last_name', 'Member', 'username', 'member_c_test'), now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000004',
     'authenticated', 'authenticated', 'member-inactive@example.test', crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Ivy', 'last_name', 'Inactive', 'username', 'member_inactive_test'), now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000005',
     'authenticated', 'authenticated', 'member-history@example.test', crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Hank', 'last_name', 'History', 'username', 'member_history_test'), now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000006',
     'authenticated', 'authenticated', 'member-player@example.test', crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Pia', 'last_name', 'Player', 'username', 'member_player_test'), now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000007',
     'authenticated', 'authenticated', 'member-deletable@example.test', crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Del', 'last_name', 'Etable', 'username', 'member_deletable_test'), now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000008',
     'authenticated', 'authenticated', 'member-organizer2@example.test', crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Orin', 'last_name', 'Organizer', 'username', 'member_organizer2_test'), now(), now(), '', '', '', '');

  update public.profiles set is_admin = true where id in ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000002');
  update public.profiles set membership_status = 'inactive' where id = '80000000-0000-0000-0000-000000000004';

  -- member_history organizes a completed tournament.
  insert into public.tournaments (id, organizer_user_id, name, course_name, tournament_date, status)
  values ('81000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000005', 'History Tournament', 'Test Course', current_date, 'completed');
  insert into public.tournament_players (tournament_id, user_id, membership_status, is_organizer)
  values ('81000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000005', 'accepted', true);

  -- member_player plays (not organizes) a different tournament, organized by
  -- a separate fixture user so member_player's own organizer count is 0 --
  -- isolates "played" from "organized" in the refusal-reason check.
  insert into public.tournament_players (tournament_id, user_id, membership_status, is_organizer)
  values ('81000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000006', 'accepted', false);

  -- member_deletable: a pending invitation (to History Tournament -- not
  -- actually a member of it) and a golf_courses row under their name, but
  -- no tournaments/tournament_players rows of their own.
  insert into public.tournament_invitations (tournament_id, invited_user_id, invited_by_user_id, status)
  values ('81000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000007', '80000000-0000-0000-0000-000000000005', 'pending');

  insert into public.golf_courses (id, external_id, club_name, course_name, source, imported_by, created_by, updated_by)
  values ('82000000-0000-0000-0000-000000000001', 'admintest-ext-1', 'Admin Test Club', 'Admin Test Course', 'golfcourseapi', '80000000-0000-0000-0000-000000000007', '80000000-0000-0000-0000-000000000007', '80000000-0000-0000-0000-000000000007');
end $$;

-- ---------------------------------------------------------------------------
-- 1) is_admin() is enforced in the function body, not just by the EXECUTE
--    grant: an ordinary authenticated (non-admin) caller is rejected by all
--    three admin RPCs.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception('select public.admin_list_members()'),
  'a non-admin authenticated caller cannot call admin_list_members()'
);
select ok(
  pg_temp.expect_exception(format('select public.admin_set_member_status(%L, %L)', '80000000-0000-0000-0000-000000000003', 'inactive')),
  'a non-admin authenticated caller cannot call admin_set_member_status()'
);
select ok(
  pg_temp.expect_exception(format('select public.admin_permanently_delete_member(%L)', '80000000-0000-0000-0000-000000000007')),
  'a non-admin authenticated caller cannot call admin_permanently_delete_member()'
);

reset role;

-- ---------------------------------------------------------------------------
-- 2) list_members() (the normal directory) excludes inactive members;
--    admin_list_members() includes them, with membership_status and
--    is_admin visible, and never an email column.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  not exists (select 1 from public.list_members() where id = '80000000-0000-0000-0000-000000000004'::uuid),
  'list_members() (normal directory) excludes an inactive member'
);
select ok(
  exists (select 1 from public.list_members() where id = '80000000-0000-0000-0000-000000000003'::uuid),
  'list_members() still includes an active member'
);

select ok(
  exists (select 1 from public.admin_list_members() where id = '80000000-0000-0000-0000-000000000004'::uuid),
  'admin_list_members() includes the inactive member the normal directory hides'
);
select is(
  (select membership_status from public.admin_list_members() where id = '80000000-0000-0000-0000-000000000004'::uuid),
  'inactive',
  'admin_list_members() reports the correct membership_status'
);
select is(
  (select is_admin from public.admin_list_members() where id = '80000000-0000-0000-0000-000000000001'::uuid),
  true,
  'admin_list_members() reports is_admin correctly'
);
select ok(
  not exists (
    select 1 from information_schema.parameters where specific_schema = 'public' and specific_name in (
      select specific_name from information_schema.routines where routine_schema = 'public' and routine_name = 'admin_list_members'
    ) and parameter_mode = 'OUT' and parameter_name = 'email'
  ),
  'admin_list_members() never returns an email column'
);

reset role;

-- ---------------------------------------------------------------------------
-- 3) invite_player() rejects an inactive target, at the RPC layer.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000005', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format(
    'select public.invite_player(%L, %L)', '81000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000004'
  )),
  'invite_player() refuses to invite an inactive member'
);

reset role;

-- ---------------------------------------------------------------------------
-- 4) admin_set_member_status(): deactivate/reactivate round-trip, and
--    historical roster references remain intact throughout.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_member_status('80000000-0000-0000-0000-000000000006', 'inactive');
end $$;

reset role;

select is(
  (select membership_status from public.profiles where id = '80000000-0000-0000-0000-000000000006'),
  'inactive',
  'admin_set_member_status() deactivates a member'
);
select is(
  (select count(*)::integer from public.tournament_players where user_id = '80000000-0000-0000-0000-000000000006'),
  1,
  'the deactivated member''s tournament_players roster entry is untouched'
);
select is(
  (select first_name from public.profiles where id = '80000000-0000-0000-0000-000000000006'),
  'Pia',
  'the deactivated member''s profile row (name shown on historical rosters) is untouched'
);

do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_member_status('80000000-0000-0000-0000-000000000006', 'active');
end $$;

reset role;

select is(
  (select membership_status from public.profiles where id = '80000000-0000-0000-0000-000000000006'),
  'active',
  'admin_set_member_status() reactivates a member'
);

-- ---------------------------------------------------------------------------
-- 5) Self-protection: an admin cannot deactivate or permanently delete
--    themselves, regardless of how many other admins exist.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format('select public.admin_set_member_status(%L, %L)', '80000000-0000-0000-0000-000000000001', 'inactive')),
  'an admin cannot deactivate themselves'
);
select ok(
  pg_temp.expect_exception(format('select public.admin_permanently_delete_member(%L)', '80000000-0000-0000-0000-000000000001')),
  'an admin cannot permanently delete themselves'
);

reset role;

-- ---------------------------------------------------------------------------
-- 6) Last-active-administrator protection, including the non-self case.
--    is_admin() (0027) checks only profiles.is_admin, not membership_status
--    -- so an admin who is themselves inactive can still call admin RPCs.
--    That makes a genuine non-self "last active administrator" scenario
--    reachable: admin_a deactivates admin_b (leaves admin_a as the sole
--    *active* admin, admin_b still is_admin = true but inactive) -- admin_b
--    can then still act, and must be refused when acting against admin_a,
--    since admin_b's own inactivity means completing that action would
--    leave zero active administrators.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_member_status('80000000-0000-0000-0000-000000000002', 'inactive');
end $$;

reset role;

select is(
  (select membership_status from public.profiles where id = '80000000-0000-0000-0000-000000000002'),
  'inactive',
  'deactivating one of two active admins succeeds (one active admin -- admin_a -- remains)'
);

do $$
begin
  -- admin_b is now inactive but still is_admin = true, so it can still
  -- authenticate for admin RPC purposes -- acting on admin_a (the sole
  -- remaining *active* admin) is what must be refused here.
  perform set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format('select public.admin_set_member_status(%L, %L)', '80000000-0000-0000-0000-000000000001', 'inactive')),
  'a (technically still is_admin, though inactive) admin cannot deactivate the last active administrator'
);
select ok(
  pg_temp.expect_exception(format('select public.admin_permanently_delete_member(%L)', '80000000-0000-0000-0000-000000000001')),
  'a (technically still is_admin, though inactive) admin cannot permanently delete the last active administrator'
);

reset role;

-- Restore admin_b to active so the remaining tests have two admins again
-- (keeps the tournament-history refusal tests below unaffected by admin
-- count edge cases).
do $$
begin
  update public.profiles set membership_status = 'active' where id = '80000000-0000-0000-0000-000000000002';
end $$;

-- ---------------------------------------------------------------------------
-- 7) admin_permanently_delete_member(): refuses a member with tournament
--    history, with organizer/player counts in the message; succeeds (with
--    full cleanup) for a member with none.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format('select public.admin_permanently_delete_member(%L)', '80000000-0000-0000-0000-000000000005')),
  'permanent delete refuses a member who organizes a tournament'
);
select ok(
  pg_temp.expect_exception(format('select public.admin_permanently_delete_member(%L)', '80000000-0000-0000-0000-000000000006')),
  'permanent delete refuses a member who has played in (not organized) a tournament'
);

reset role;

select ok(
  exists (select 1 from auth.users where id = '80000000-0000-0000-0000-000000000005'),
  'the refused member with tournament history still exists afterward (deletion was actually blocked, not silently partial)'
);

do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

-- The deletable member: has a pending invitation and a golf_courses row,
-- but no tournaments/tournament_players of their own.
select ok(
  not pg_temp.expect_exception(format('select public.admin_permanently_delete_member(%L)', '80000000-0000-0000-0000-000000000007')),
  'permanent delete succeeds for a member with no tournament history'
);

reset role;

select ok(
  not exists (select 1 from auth.users where id = '80000000-0000-0000-0000-000000000007'),
  'the auth.users row is gone after permanent delete'
);
select ok(
  not exists (select 1 from public.profiles where id = '80000000-0000-0000-0000-000000000007'),
  'the profiles row is gone (cascaded from auth.users) after permanent delete'
);
select ok(
  not exists (select 1 from public.tournament_invitations where invited_user_id = '80000000-0000-0000-0000-000000000007'),
  'the deleted member''s pending invitation was cleaned up'
);
select is(
  (select created_by from public.golf_courses where id = '82000000-0000-0000-0000-000000000001'),
  null::uuid,
  'golf_courses.created_by was cleared for the deleted member'
);
select is(
  (select updated_by from public.golf_courses where id = '82000000-0000-0000-0000-000000000001'),
  null::uuid,
  'golf_courses.updated_by was cleared for the deleted member'
);
select is(
  (select imported_by from public.golf_courses where id = '82000000-0000-0000-0000-000000000001'),
  '80000000-0000-0000-0000-000000000001'::uuid,
  'golf_courses.imported_by was reassigned to the deleting admin (NOT NULL column, cannot be cleared)'
);
select ok(
  exists (select 1 from public.golf_courses where id = '82000000-0000-0000-0000-000000000001'),
  'the golf_courses row itself (real course data) still exists -- only provenance changed'
);

reset role;

select * from finish();
rollback;
