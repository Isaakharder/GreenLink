-- ============================================================================
-- submit_team_score(): replaces the 0015 version. Adds optimistic-concurrency
-- conflict detection so two teammates editing the same hole while offline
-- never silently clobber each other. Returns jsonb instead of
-- team_hole_scores so it can carry either a confirmed score or a structured
-- conflict payload without raising an exception (a conflict is an expected
-- outcome the client must present to the user, not an error).
--
-- Concurrency: the update/insert is guarded by `where revision = p_expected_
-- revision` (resp. `on conflict ... do nothing`), which is race-free without
-- explicit locking -- two concurrent submissions can't both "win".
-- ============================================================================

alter table public.score_operations
  add column expected_revision integer;

create or replace function public.submit_team_score(
  p_operation_uuid uuid,
  p_tournament_id uuid,
  p_team_id uuid,
  p_hole_number integer,
  p_new_strokes integer,
  p_expected_revision integer,
  p_device_timestamp timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_status text;
  v_previous_strokes integer;
  v_existing_operation record;
  v_result public.team_hole_scores;
  v_current public.team_hole_scores;
  v_updated_by_name text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_new_strokes < 1 then
    raise exception 'strokes must be at least 1';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'expected revision must be provided';
  end if;

  -- Idempotency: a resend of an already-applied operation returns the
  -- current row untouched instead of applying the change again.
  select * into v_existing_operation
  from public.score_operations
  where operation_uuid = p_operation_uuid;

  if found then
    select * into v_result
    from public.team_hole_scores
    where tournament_id = p_tournament_id
      and team_id = p_team_id
      and hole_number = p_hole_number;
    return jsonb_build_object('status', 'ok', 'score', to_jsonb(v_result));
  end if;

  if not (
    public.is_team_member(p_tournament_id, p_team_id)
    or public.is_tournament_organizer(p_tournament_id)
  ) then
    raise exception 'you are not assigned to this team';
  end if;

  select status into v_tournament_status
  from public.tournaments
  where id = p_tournament_id;

  if v_tournament_status is distinct from 'live' then
    raise exception 'scores can only be submitted while the tournament is live';
  end if;

  if p_expected_revision = 0 then
    v_previous_strokes := null;

    insert into public.team_hole_scores (
      tournament_id, team_id, hole_number, strokes, revision, last_updated_by, updated_at
    )
    values (
      p_tournament_id, p_team_id, p_hole_number, p_new_strokes, 1, auth.uid(), now()
    )
    on conflict (tournament_id, team_id, hole_number) do nothing
    returning * into v_result;
  else
    select strokes into v_previous_strokes
    from public.team_hole_scores
    where tournament_id = p_tournament_id
      and team_id = p_team_id
      and hole_number = p_hole_number
      and revision = p_expected_revision;

    update public.team_hole_scores
    set strokes = p_new_strokes,
        revision = revision + 1,
        last_updated_by = auth.uid(),
        updated_at = now()
    where tournament_id = p_tournament_id
      and team_id = p_team_id
      and hole_number = p_hole_number
      and revision = p_expected_revision
    returning * into v_result;
  end if;

  if v_result.id is not null then
    insert into public.score_operations (
      operation_uuid, tournament_id, team_id, hole_number,
      previous_strokes, new_strokes, revision, changed_by, device_timestamp,
      expected_revision
    )
    values (
      p_operation_uuid, p_tournament_id, p_team_id, p_hole_number,
      v_previous_strokes, p_new_strokes, v_result.revision, auth.uid(), p_device_timestamp,
      p_expected_revision
    );

    return jsonb_build_object('status', 'ok', 'score', to_jsonb(v_result));
  end if;

  -- Conflict: either the row already existed (expected_revision = 0 case)
  -- or someone else's update landed first (revision mismatch case). Either
  -- way, report the current server state instead of applying this change.
  select * into v_current
  from public.team_hole_scores
  where tournament_id = p_tournament_id
    and team_id = p_team_id
    and hole_number = p_hole_number;

  select trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
  into v_updated_by_name
  from public.profiles
  where id = v_current.last_updated_by;

  return jsonb_build_object(
    'status', 'conflict',
    'server', jsonb_build_object(
      'strokes', v_current.strokes,
      'revision', v_current.revision,
      'updated_by_user_id', v_current.last_updated_by,
      'updated_by_name', nullif(v_updated_by_name, ''),
      'updated_at', v_current.updated_at
    ),
    'submitted', jsonb_build_object('strokes', p_new_strokes)
  );
end;
$$;

revoke execute on function public.submit_team_score(uuid, uuid, uuid, integer, integer, integer, timestamptz) from public;
grant execute on function public.submit_team_score(uuid, uuid, uuid, integer, integer, integer, timestamptz) to authenticated;

-- The 0015 six-argument signature (no p_expected_revision) is superseded by
-- the seven-argument version above; drop it so callers can't silently use
-- the old no-conflict-detection path.
drop function if exists public.submit_team_score(uuid, uuid, uuid, integer, integer, timestamptz);

-- correct_team_score is organizer-only, bypasses revision checks by design
-- (an organizer correction always wins and is always audited), and its
-- return shape/signature are unchanged from 0015.
