-- ============================================================================
-- Read policies for scores + audit trail. All members of a tournament can see
-- every team's scores ("Every team can view all teams' scores").
-- ============================================================================

create policy "team_hole_scores_select_members"
  on public.team_hole_scores for select
  to authenticated
  using (public.is_tournament_member(tournament_id) or public.is_tournament_organizer(tournament_id));

create policy "score_operations_select_members"
  on public.score_operations for select
  to authenticated
  using (public.is_tournament_member(tournament_id) or public.is_tournament_organizer(tournament_id));

-- No INSERT/UPDATE policy on either table: all writes happen inside the
-- SECURITY DEFINER functions below, which run as the table owner (bypassing
-- RLS) and enforce the real business rules themselves.

-- ============================================================================
-- submit_team_score(): used by a player assigned to a team while the
-- tournament is live. Idempotent on operation_uuid so the offline queue can
-- safely resend without double-applying a change.
-- ============================================================================

create function public.submit_team_score(
  p_operation_uuid uuid,
  p_tournament_id uuid,
  p_team_id uuid,
  p_hole_number integer,
  p_new_strokes integer,
  p_device_timestamp timestamptz default null
)
returns public.team_hole_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_status text;
  v_previous_strokes integer;
  v_revision integer;
  v_existing_operation record;
  v_result public.team_hole_scores;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
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
    return v_result;
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

  select strokes into v_previous_strokes
  from public.team_hole_scores
  where tournament_id = p_tournament_id
    and team_id = p_team_id
    and hole_number = p_hole_number;

  insert into public.team_hole_scores (
    tournament_id, team_id, hole_number, strokes, revision, last_updated_by, updated_at
  )
  values (
    p_tournament_id, p_team_id, p_hole_number, p_new_strokes, 1, auth.uid(), now()
  )
  on conflict (tournament_id, team_id, hole_number)
  do update set
    strokes = excluded.strokes,
    revision = public.team_hole_scores.revision + 1,
    last_updated_by = excluded.last_updated_by,
    updated_at = now()
  returning * into v_result;

  v_revision := v_result.revision;

  insert into public.score_operations (
    operation_uuid, tournament_id, team_id, hole_number,
    previous_strokes, new_strokes, revision, changed_by, device_timestamp
  )
  values (
    p_operation_uuid, p_tournament_id, p_team_id, p_hole_number,
    v_previous_strokes, p_new_strokes, v_revision, auth.uid(), p_device_timestamp
  );

  return v_result;
end;
$$;

grant execute on function public.submit_team_score(uuid, uuid, uuid, integer, integer, timestamptz) to authenticated;

-- ============================================================================
-- correct_team_score(): organizer-only, works regardless of tournament status
-- (live or completed), always requires a reason, and is always audited. This
-- is the "clearly identified correction function" required for completed
-- tournaments, and organizers use it during live play too so every
-- organizer-made change is equally auditable.
-- ============================================================================

create function public.correct_team_score(
  p_operation_uuid uuid,
  p_tournament_id uuid,
  p_team_id uuid,
  p_hole_number integer,
  p_new_strokes integer,
  p_change_reason text,
  p_device_timestamp timestamptz default null
)
returns public.team_hole_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_strokes integer;
  v_revision integer;
  v_existing_operation record;
  v_result public.team_hole_scores;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can correct scores';
  end if;

  if p_change_reason is null or length(trim(p_change_reason)) = 0 then
    raise exception 'a reason is required to correct a score';
  end if;

  select * into v_existing_operation
  from public.score_operations
  where operation_uuid = p_operation_uuid;

  if found then
    select * into v_result
    from public.team_hole_scores
    where tournament_id = p_tournament_id
      and team_id = p_team_id
      and hole_number = p_hole_number;
    return v_result;
  end if;

  select strokes into v_previous_strokes
  from public.team_hole_scores
  where tournament_id = p_tournament_id
    and team_id = p_team_id
    and hole_number = p_hole_number;

  insert into public.team_hole_scores (
    tournament_id, team_id, hole_number, strokes, revision, last_updated_by, updated_at
  )
  values (
    p_tournament_id, p_team_id, p_hole_number, p_new_strokes, 1, auth.uid(), now()
  )
  on conflict (tournament_id, team_id, hole_number)
  do update set
    strokes = excluded.strokes,
    revision = public.team_hole_scores.revision + 1,
    last_updated_by = excluded.last_updated_by,
    updated_at = now()
  returning * into v_result;

  v_revision := v_result.revision;

  insert into public.score_operations (
    operation_uuid, tournament_id, team_id, hole_number,
    previous_strokes, new_strokes, revision, changed_by, device_timestamp, change_reason
  )
  values (
    p_operation_uuid, p_tournament_id, p_team_id, p_hole_number,
    v_previous_strokes, p_new_strokes, v_revision, auth.uid(), p_device_timestamp, p_change_reason
  );

  return v_result;
end;
$$;

grant execute on function public.correct_team_score(uuid, uuid, uuid, integer, integer, text, timestamptz) to authenticated;
