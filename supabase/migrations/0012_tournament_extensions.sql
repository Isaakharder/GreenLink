-- ============================================================================
-- Schema extensions for the tournament setup workflow.
-- ============================================================================

alter table public.tournaments
  add column description text;

alter table public.tournament_holes
  add column distance_unit text not null default 'yards'
    check (distance_unit in ('yards', 'metres'));

-- Invitations can now be cancelled by the organizer (distinct from the
-- invitee declining) and re-sent, which reuses the same row rather than
-- fighting the unique(tournament_id, invited_user_id) constraint.
alter table public.tournament_invitations
  drop constraint tournament_invitations_status_check;

alter table public.tournament_invitations
  add constraint tournament_invitations_status_check
    check (status in ('pending', 'accepted', 'declined', 'cancelled'));

-- ============================================================================
-- Hardening pass: PostgreSQL grants EXECUTE on new functions to PUBLIC by
-- default. The functions added in 0009/0010 were granted to `authenticated`
-- but never explicitly revoked from `public`, so `anon`/`public` still had
-- implicit execute rights. Close that gap; every function below keeps
-- working identically for `authenticated`, and gets nothing for anyone else.
-- ============================================================================

revoke execute on function public.is_username_available(text) from public;
grant execute on function public.is_username_available(text) to anon, authenticated;
-- (is_username_available intentionally stays available to anon too: it backs
-- the sign-up form's availability check, which runs before a session exists.)

revoke execute on function public.search_profile_by_username(text) from public;
grant execute on function public.search_profile_by_username(text) to authenticated;

revoke execute on function public.is_tournament_member(uuid) from public;
grant execute on function public.is_tournament_member(uuid) to authenticated;

revoke execute on function public.is_tournament_organizer(uuid) from public;
grant execute on function public.is_tournament_organizer(uuid) to authenticated;

revoke execute on function public.is_team_member(uuid, uuid) from public;
grant execute on function public.is_team_member(uuid, uuid) to authenticated;

revoke execute on function public.create_tournament(text, text, date, integer, text, integer) from public;
grant execute on function public.create_tournament(text, text, date, integer, text, integer) to authenticated;

revoke execute on function public.invite_player(uuid, uuid) from public;
grant execute on function public.invite_player(uuid, uuid) to authenticated;

revoke execute on function public.accept_invitation(uuid) from public;
grant execute on function public.accept_invitation(uuid) to authenticated;

revoke execute on function public.decline_invitation(uuid) from public;
grant execute on function public.decline_invitation(uuid) to authenticated;

revoke execute on function public.submit_team_score(uuid, uuid, uuid, integer, integer, timestamptz) from public;
grant execute on function public.submit_team_score(uuid, uuid, uuid, integer, integer, timestamptz) to authenticated;

revoke execute on function public.correct_team_score(uuid, uuid, uuid, integer, integer, text, timestamptz) from public;
grant execute on function public.correct_team_score(uuid, uuid, uuid, integer, integer, text, timestamptz) to authenticated;
