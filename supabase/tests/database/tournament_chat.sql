-- ============================================================================
-- pgTAP suite for live tournament chat (supabase/migrations/0025).
-- Covers: organizer/accepted-player send, outsider/invited-only cannot
-- read or send, sender cannot be spoofed (no INSERT policy exists at all),
-- completed tournament rejects send, empty/oversized messages rejected,
-- unread-count math via mark_tournament_chat_read/get_tournament_chat_
-- summary, own-message delete, organizer-delete-of-any-message,
-- non-sender-non-organizer cannot delete, and idempotent resend via
-- operation_uuid inserts exactly one row. Same fixture/impersonation
-- pattern as tournament_setup_rules.sql / personal_rounds.sql.
--
-- Run with: supabase test db
-- ============================================================================

begin;

create extension if not exists pgtap;
create extension if not exists pgcrypto;

select plan(22);

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
-- Fixtures: organizer + an accepted player, each on their own team; an
-- invited-but-never-accepted user; and a total outsider never invited at
-- all. A 1-hole, team-size-1 tournament so start_tournament() succeeds with
-- minimal setup.
-- ---------------------------------------------------------------------------

do $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000001',
     'authenticated', 'authenticated', 'chat-organizer@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Oona', 'last_name', 'Organizer', 'username', 'chat_organizer_test'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000002',
     'authenticated', 'authenticated', 'chat-player@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Pia', 'last_name', 'Player', 'username', 'chat_player_test'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000003',
     'authenticated', 'authenticated', 'chat-invited@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Ivy', 'last_name', 'Invited', 'username', 'chat_invited_test'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000004',
     'authenticated', 'authenticated', 'chat-outsider@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Otis', 'last_name', 'Outsider', 'username', 'chat_outsider_test'),
     now(), now(), '', '', '', '');
end $$;

do $$
declare
  v_tournament uuid;
  v_invitation uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_tournament := public.create_tournament('Chat Cup', 'Chat Course', current_date, 1, 'Team Scramble', 1);
  v_invitation := public.invite_player(v_tournament, '40000000-0000-0000-0000-000000000002');
  perform public.invite_player(v_tournament, '40000000-0000-0000-0000-000000000003'); -- never accepted

  perform pg_temp.remember('tournament', v_tournament::text);
  perform pg_temp.remember('invitation_player', v_invitation::text);
end $$;

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.accept_invitation(pg_temp.recall('invitation_player')::uuid);
end $$;

reset role;

do $$
declare
  v_team_organizer uuid;
  v_team_player uuid;
  v_organizer_player_id uuid;
  v_player_player_id uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_team_organizer := (public.create_tournament_team(pg_temp.recall('tournament')::uuid, 'Team Organizer')).id;
  v_team_player := (public.create_tournament_team(pg_temp.recall('tournament')::uuid, 'Team Player')).id;

  select id into v_organizer_player_id from public.tournament_players
    where tournament_id = pg_temp.recall('tournament')::uuid and user_id = '40000000-0000-0000-0000-000000000001';
  select id into v_player_player_id from public.tournament_players
    where tournament_id = pg_temp.recall('tournament')::uuid and user_id = '40000000-0000-0000-0000-000000000002';

  perform public.assign_tournament_player(v_organizer_player_id, v_team_organizer);
  perform public.assign_tournament_player(v_player_player_id, v_team_player);

  perform public.save_tournament_holes(
    pg_temp.recall('tournament')::uuid,
    jsonb_build_array(jsonb_build_object('hole_number', 1, 'par', 4))
  );

  perform pg_temp.remember('team_player', v_team_player::text);
  perform public.start_tournament(pg_temp.recall('tournament')::uuid);
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 1) Outsider and invited-but-not-accepted cannot read before anything's
--    been sent (RLS returns zero rows -- not an error, just nothing visible).
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000004', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select count(*) from public.tournament_messages where tournament_id = pg_temp.recall('tournament')::uuid),
  0::bigint,
  'a total outsider reads zero messages via RLS'
);

select ok(
  pg_temp.expect_exception(format('select public.send_tournament_message(%L, gen_random_uuid(), %L)', pg_temp.recall('tournament'), 'hi')),
  'a total outsider cannot send a message'
);

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select count(*) from public.tournament_messages where tournament_id = pg_temp.recall('tournament')::uuid),
  0::bigint,
  'an invited-but-never-accepted user reads zero messages via RLS'
);

select ok(
  pg_temp.expect_exception(format('select public.send_tournament_message(%L, gen_random_uuid(), %L)', pg_temp.recall('tournament'), 'hi')),
  'an invited-but-never-accepted user cannot send a message'
);

reset role;

-- ---------------------------------------------------------------------------
-- 2) Sender cannot be spoofed: no INSERT policy exists on tournament_messages
--    at all, so even an accepted member's direct insert attempt is rejected
--    outright, independent of whatever sender_user_id they claim.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format(
    'insert into public.tournament_messages (operation_uuid, tournament_id, sender_user_id, message_text) values (gen_random_uuid(), %L, %L, %L)',
    pg_temp.recall('tournament'), '40000000-0000-0000-0000-000000000001', 'pretending to be the organizer'
  )),
  'no direct insert policy exists -- sender_user_id cannot be spoofed via a raw insert'
);

reset role;

-- ---------------------------------------------------------------------------
-- 3) Organizer and accepted player can both send; empty/oversized messages
--    are rejected.
-- ---------------------------------------------------------------------------

do $$
declare
  v_message public.tournament_messages;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_message := public.send_tournament_message(pg_temp.recall('tournament')::uuid, gen_random_uuid(), '  Nice drive!  ');
  perform pg_temp.remember('organizer_message', v_message.id::text);
end $$;

select is(
  (select sender_user_id from public.tournament_messages where id = pg_temp.recall('organizer_message')::uuid),
  '40000000-0000-0000-0000-000000000001'::uuid,
  'the organizer can send, and the row records the true caller as sender'
);

select is(
  (select message_text from public.tournament_messages where id = pg_temp.recall('organizer_message')::uuid),
  'Nice drive!',
  'the message is trimmed before storage'
);

select is(
  (select sender_team_id from public.tournament_messages where id = pg_temp.recall('organizer_message')::uuid),
  (select team_id from public.tournament_players where tournament_id = pg_temp.recall('tournament')::uuid and user_id = '40000000-0000-0000-0000-000000000001'),
  'sender_team_id is snapshotted from the sender''s current team assignment'
);

reset role;

do $$
declare
  v_message public.tournament_messages;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_message := public.send_tournament_message(pg_temp.recall('tournament')::uuid, gen_random_uuid(), 'Thanks!');
  perform pg_temp.remember('player_message', v_message.id::text);
end $$;

select is(
  (select sender_user_id from public.tournament_messages where id = pg_temp.recall('player_message')::uuid),
  '40000000-0000-0000-0000-000000000002'::uuid,
  'an accepted player can send'
);

select ok(
  pg_temp.expect_exception(format('select public.send_tournament_message(%L, gen_random_uuid(), %L)', pg_temp.recall('tournament'), '   ')),
  'a whitespace-only message is rejected'
);

select ok(
  pg_temp.expect_exception(format('select public.send_tournament_message(%L, gen_random_uuid(), %L)', pg_temp.recall('tournament'), repeat('a', 501))),
  'a message over 500 characters is rejected'
);

select lives_ok(
  format('select public.send_tournament_message(%L, gen_random_uuid(), %L)', pg_temp.recall('tournament'), repeat('a', 500)),
  'a message of exactly 500 characters is accepted'
);

reset role;

-- ---------------------------------------------------------------------------
-- 4) Idempotent resend: the same operation_uuid never creates a second row.
-- ---------------------------------------------------------------------------

do $$
declare
  v_op uuid := gen_random_uuid();
  v_first public.tournament_messages;
  v_second public.tournament_messages;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_first := public.send_tournament_message(pg_temp.recall('tournament')::uuid, v_op, 'resend me');
  v_second := public.send_tournament_message(pg_temp.recall('tournament')::uuid, v_op, 'resend me');

  perform pg_temp.remember('resend_op', v_op::text);
  perform pg_temp.remember('resend_first_id', v_first.id::text);
  perform pg_temp.remember('resend_second_id', v_second.id::text);
end $$;

select is(
  (select count(*) from public.tournament_messages where operation_uuid = pg_temp.recall('resend_op')::uuid),
  1::bigint,
  'resending the same operation_uuid never creates a second row'
);

select is(
  pg_temp.recall('resend_first_id'),
  pg_temp.recall('resend_second_id'),
  'both calls return the same message row'
);

reset role;

-- ---------------------------------------------------------------------------
-- 5) Unread count math: the player has two unread messages from the
--    organizer (the "Nice drive!" one and none from themself); marking read
--    zeroes it out.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  ((public.get_tournament_chat_summary(pg_temp.recall('tournament')::uuid) ->> 'unread_count')::int),
  1,
  'the player has exactly one unread message (the organizer''s -- their own message never counts as unread for themself)'
);

do $$
begin
  perform public.mark_tournament_chat_read(pg_temp.recall('tournament')::uuid);
end $$;

select is(
  ((public.get_tournament_chat_summary(pg_temp.recall('tournament')::uuid) ->> 'unread_count')::int),
  0,
  'marking the chat read zeroes the unread count'
);

reset role;

-- ---------------------------------------------------------------------------
-- 6) Deletion: own-message delete, organizer-deletes-any-message, and a
--    non-sender-non-organizer cannot delete someone else's message.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select deleted_by from public.delete_tournament_message(pg_temp.recall('player_message')::uuid)),
  '40000000-0000-0000-0000-000000000001'::uuid,
  'the organizer can delete another member''s message'
);

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format('select public.delete_tournament_message(%L)', pg_temp.recall('organizer_message'))),
  'a non-sender, non-organizer cannot delete someone else''s message'
);

select is(
  (select deleted_by from public.delete_tournament_message(pg_temp.recall('resend_first_id')::uuid)),
  '40000000-0000-0000-0000-000000000002'::uuid,
  'a member can delete their own message'
);

select is(
  (select message_text from public.tournament_messages where id = pg_temp.recall('resend_first_id')::uuid),
  'resend me',
  'soft delete preserves message_text (audit-friendly, not a hard delete)'
);

reset role;

-- ---------------------------------------------------------------------------
-- 7) Completed tournament: history is preserved and still readable, but new
--    messages are rejected.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.finish_tournament(pg_temp.recall('tournament')::uuid, true, 'test fixture close-out');
end $$;

select ok(
  pg_temp.expect_exception(format('select public.send_tournament_message(%L, gen_random_uuid(), %L)', pg_temp.recall('tournament'), 'too late')),
  'a completed tournament rejects new messages'
);

select ok(
  (select count(*) from public.tournament_messages where tournament_id = pg_temp.recall('tournament')::uuid) > 0,
  'chat history is preserved (still readable) after the tournament completes'
);

reset role;

select * from finish();
rollback;
