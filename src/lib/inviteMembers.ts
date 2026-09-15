import type { Member } from '../types/database';
import type { RosterInvitation, RosterPlayer } from '../hooks/useTournamentRoster';

export type InviteStatus = 'accepted' | 'pending' | 'invite';

/**
 * A member's current relationship to one tournament, derived only from the
 * tournament_players/tournament_invitations data useTournamentRoster already
 * loads -- no separate client-side status source, so a status here can never
 * drift from what invite_player()/cancel_tournament_invitation() actually
 * recorded. A declined/cancelled invitation (or no invitation at all) both
 * resolve to 'invite': invite_player() already revives a declined/cancelled
 * invitation in place rather than erroring, so the same action correctly
 * covers "never invited" and "invite again" -- and since 'accepted'/'pending'
 * never fall through to 'invite', the UI can never render a second Invite
 * button for someone already on this tournament in some form.
 */
export function resolveInviteStatus(
  memberId: string,
  players: RosterPlayer[],
  invitations: RosterInvitation[],
): InviteStatus {
  if (players.some((p) => p.userId === memberId)) return 'accepted';
  if (invitations.some((i) => i.invitedUserId === memberId && i.status === 'pending')) return 'pending';
  return 'invite';
}

/**
 * Every GreenLink member except the current user (the organizer can't invite
 * themselves), sorted alphabetically by first name then last name so the
 * list never reorders based on database/network return order.
 */
export function invitableMembers(members: Member[], currentUserId: string | undefined): Member[] {
  return [...members]
    .filter((member) => member.id !== currentUserId)
    .sort((a, b) => a.first_name.localeCompare(b.first_name) || a.last_name.localeCompare(b.last_name));
}
