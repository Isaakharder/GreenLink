-- ============================================================================
-- Live tournament chat: one shared channel per tournament (not per-team --
-- see the forward-compat note on sender_team_id below). Every write goes
-- through a SECURITY DEFINER function; no table ever gets a direct
-- INSERT/UPDATE/DELETE policy, matching the pattern already established for
-- team_hole_scores/tournament_holes/tournament_players elsewhere in this
-- schema. Every function derives the actor from auth.uid() and never
-- accepts a client-supplied sender id, so spoofing isn't just rejected by
-- validation -- there is no code path that could accept one.
-- ============================================================================

create table public.tournament_messages (
  id uuid primary key default gen_random_uuid(),
  operation_uuid uuid unique not null,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  sender_user_id uuid not null references public.profiles (id),
  -- Snapshotted at send time (see send_tournament_message) rather than
  -- joined live: team assignment is frozen once a tournament is live
  -- (assign_tournament_player/unassign_tournament_player both refuse once
  -- status is no longer draft/upcoming), so a snapshot is both simpler than
  -- a live join and more historically correct if that ever changes.
  sender_team_id uuid references public.tournament_teams (id) on delete set null,
  message_text text not null,
  created_at timestamptz not null default now(),
  -- Reserved for a future edit feature -- always null in Phase 1, no edit
  -- RPC is built, kept only so a later migration can add editing without
  -- reshaping this table.
  edited_at timestamptz,
  -- Soft delete only (audit-friendly, per the brief): message_text is never
  -- destroyed, but every client renders "Message removed" once deleted_at
  -- is set instead of the real text.
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id)
);

create index tournament_messages_tournament_created_idx on public.tournament_messages (tournament_id, created_at);

alter table public.tournament_messages enable row level security;

create policy "tournament_messages_select_members"
  on public.tournament_messages for select
  to authenticated
  using (public.is_tournament_member(tournament_id) or public.is_tournament_organizer(tournament_id));

-- No INSERT/UPDATE/DELETE policy: all writes happen inside
-- send_tournament_message()/delete_tournament_message() below.

-- ============================================================================
-- tournament_chat_reads: one row per member (not one row per message) --
-- the simplest design that still supports an efficient unread count
-- (count messages newer than this timestamp), per the brief's own framing
-- of the tradeoff.
-- ============================================================================

create table public.tournament_chat_reads (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  last_read_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

alter table public.tournament_chat_reads enable row level security;

create policy "tournament_chat_reads_select_own"
  on public.tournament_chat_reads for select
  to authenticated
  using (user_id = auth.uid());

-- No direct write policy: written only by mark_tournament_chat_read() below.

-- ============================================================================
-- send_tournament_message(): membership + live-only + trim/length-validated,
-- idempotent on p_operation_uuid so the offline queue can safely resend
-- without ever creating a duplicate message.
-- ============================================================================

create function public.send_tournament_message(
  p_tournament_id uuid,
  p_operation_uuid uuid,
  p_message_text text
)
returns public.tournament_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_trimmed text;
  v_sender_team_id uuid;
  v_result public.tournament_messages;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (public.is_tournament_member(p_tournament_id) or public.is_tournament_organizer(p_tournament_id)) then
    raise exception 'only accepted tournament members can send messages';
  end if;

  select status into v_status from public.tournaments where id = p_tournament_id;
  if v_status is null then
    raise exception 'tournament not found';
  end if;
  if v_status <> 'live' then
    raise exception 'messages can only be sent while the tournament is live';
  end if;

  v_trimmed := trim(coalesce(p_message_text, ''));
  if length(v_trimmed) = 0 then
    raise exception 'message cannot be empty';
  end if;
  if length(v_trimmed) > 500 then
    raise exception 'message cannot be longer than 500 characters';
  end if;

  select team_id into v_sender_team_id
  from public.tournament_players
  where tournament_id = p_tournament_id and user_id = auth.uid();

  insert into public.tournament_messages (operation_uuid, tournament_id, sender_user_id, sender_team_id, message_text)
  values (p_operation_uuid, p_tournament_id, auth.uid(), v_sender_team_id, v_trimmed)
  on conflict (operation_uuid) do nothing
  returning * into v_result;

  if v_result.id is null then
    -- Resend of an already-applied operation (offline retry): return the
    -- existing row untouched instead of raising or duplicating it.
    select * into v_result from public.tournament_messages where operation_uuid = p_operation_uuid;
  end if;

  return v_result;
end;
$$;

revoke execute on function public.send_tournament_message(uuid, uuid, text) from public;
grant execute on function public.send_tournament_message(uuid, uuid, text) to authenticated;

-- ============================================================================
-- delete_tournament_message(): sender or organizer only. Soft delete.
-- ============================================================================

create function public.delete_tournament_message(p_message_id uuid)
returns public.tournament_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_sender_user_id uuid;
  v_result public.tournament_messages;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select tournament_id, sender_user_id into v_tournament_id, v_sender_user_id
  from public.tournament_messages
  where id = p_message_id;

  if v_tournament_id is null then
    raise exception 'message not found';
  end if;

  if v_sender_user_id <> auth.uid() and not public.is_tournament_organizer(v_tournament_id) then
    raise exception 'only the sender or the tournament organizer can delete this message';
  end if;

  update public.tournament_messages
  set deleted_at = now(), deleted_by = auth.uid()
  where id = p_message_id
  returning * into v_result;

  return v_result;
end;
$$;

revoke execute on function public.delete_tournament_message(uuid) from public;
grant execute on function public.delete_tournament_message(uuid) to authenticated;

-- ============================================================================
-- mark_tournament_chat_read(): upserts the caller's own read marker.
-- ============================================================================

create function public.mark_tournament_chat_read(p_tournament_id uuid)
returns public.tournament_chat_reads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.tournament_chat_reads;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (public.is_tournament_member(p_tournament_id) or public.is_tournament_organizer(p_tournament_id)) then
    raise exception 'only accepted tournament members can read this chat';
  end if;

  insert into public.tournament_chat_reads (tournament_id, user_id, last_read_at)
  values (p_tournament_id, auth.uid(), now())
  on conflict (tournament_id, user_id) do update set last_read_at = excluded.last_read_at
  returning * into v_result;

  return v_result;
end;
$$;

revoke execute on function public.mark_tournament_chat_read(uuid) from public;
grant execute on function public.mark_tournament_chat_read(uuid) to authenticated;

-- ============================================================================
-- get_tournament_chat_summary(): one round trip to seed the chat hook --
-- current unread count (messages from other people since last_read_at,
-- excluding soft-deleted rows) plus the read marker itself.
-- ============================================================================

create function public.get_tournament_chat_summary(p_tournament_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_last_read_at timestamptz;
  v_unread_count integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (public.is_tournament_member(p_tournament_id) or public.is_tournament_organizer(p_tournament_id)) then
    raise exception 'only accepted tournament members can read this chat';
  end if;

  select last_read_at into v_last_read_at
  from public.tournament_chat_reads
  where tournament_id = p_tournament_id and user_id = auth.uid();

  select count(*) into v_unread_count
  from public.tournament_messages
  where tournament_id = p_tournament_id
    and sender_user_id <> auth.uid()
    and deleted_at is null
    and (v_last_read_at is null or created_at > v_last_read_at);

  return jsonb_build_object('unread_count', v_unread_count, 'last_read_at', v_last_read_at);
end;
$$;

revoke execute on function public.get_tournament_chat_summary(uuid) from public;
grant execute on function public.get_tournament_chat_summary(uuid) to authenticated;

-- ============================================================================
-- get_my_tournament_unread_counts(): bulk unread counts across every live
-- tournament the caller belongs to, for the Tournaments-list badge -- one
-- query instead of a realtime subscription per card.
-- ============================================================================

create function public.get_my_tournament_unread_counts()
returns table (tournament_id uuid, unread_count integer)
language sql
security definer
set search_path = public
stable
as $$
  select
    t.id as tournament_id,
    count(m.id) filter (
      where m.sender_user_id <> auth.uid()
        and m.deleted_at is null
        and (r.last_read_at is null or m.created_at > r.last_read_at)
    )::integer as unread_count
  from public.tournaments t
  join public.tournament_players tp
    on tp.tournament_id = t.id and tp.user_id = auth.uid() and tp.membership_status = 'accepted'
  left join public.tournament_chat_reads r on r.tournament_id = t.id and r.user_id = auth.uid()
  left join public.tournament_messages m on m.tournament_id = t.id
  where t.status = 'live'
  group by t.id;
$$;

revoke execute on function public.get_my_tournament_unread_counts() from public;
grant execute on function public.get_my_tournament_unread_counts() to authenticated;

-- ============================================================================
-- Realtime: row visibility for the change stream is still governed by the
-- SELECT policy above (see 0011_realtime.sql).
-- ============================================================================

alter publication supabase_realtime add table public.tournament_messages;
