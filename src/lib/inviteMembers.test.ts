import { describe, expect, it } from 'vitest';
import { invitableMembers, resolveInviteStatus } from './inviteMembers';
import type { Member } from '../types/database';
import type { RosterInvitation, RosterPlayer } from '../hooks/useTournamentRoster';

function member(overrides: Partial<Member> & { id: string }): Member {
  return {
    first_name: 'First',
    last_name: 'Last',
    username: 'user',
    photo_path: null,
    completed_rounds_count: 0,
    member_since: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function player(overrides: Partial<RosterPlayer> & { userId: string }): RosterPlayer {
  return {
    playerId: `player-${overrides.userId}`,
    name: 'Player',
    username: 'player',
    photoPath: null,
    teamId: null,
    isOrganizer: false,
    joinedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function invitation(overrides: Partial<RosterInvitation> & { invitedUserId: string }): RosterInvitation {
  return {
    id: `invite-${overrides.invitedUserId}`,
    name: 'Invitee',
    username: 'invitee',
    photoPath: null,
    status: 'pending',
    createdAt: '2026-01-01T00:00:00Z',
    respondedAt: null,
    ...overrides,
  };
}

describe('resolveInviteStatus', () => {
  it('is "accepted" when the member is already an accepted tournament_players row', () => {
    expect(resolveInviteStatus('u1', [player({ userId: 'u1' })], [])).toBe('accepted');
  });

  it('is "pending" when there is a pending invitation and no player row yet', () => {
    expect(resolveInviteStatus('u1', [], [invitation({ invitedUserId: 'u1', status: 'pending' })])).toBe('pending');
  });

  it('is "invite" for a member never invited at all', () => {
    expect(resolveInviteStatus('u1', [], [])).toBe('invite');
  });

  it('is "invite" for a declined invitation -- invite_player() revives it in place, so the same action applies', () => {
    expect(resolveInviteStatus('u1', [], [invitation({ invitedUserId: 'u1', status: 'declined' })])).toBe('invite');
  });

  it('is "invite" for a cancelled invitation, same reasoning as declined', () => {
    expect(resolveInviteStatus('u1', [], [invitation({ invitedUserId: 'u1', status: 'cancelled' })])).toBe('invite');
  });

  it('prefers "accepted" over a stale pending invitation for the same member (player row is the newer truth)', () => {
    const status = resolveInviteStatus(
      'u1',
      [player({ userId: 'u1' })],
      [invitation({ invitedUserId: 'u1', status: 'pending' })],
    );
    expect(status).toBe('accepted');
  });

  it('never confuses one member with another', () => {
    expect(resolveInviteStatus('u2', [player({ userId: 'u1' })], [invitation({ invitedUserId: 'u1', status: 'pending' })])).toBe(
      'invite',
    );
  });
});

describe('invitableMembers', () => {
  it('excludes the current user (the organizer cannot invite themselves)', () => {
    const members = [member({ id: 'organizer' }), member({ id: 'u1' })];
    const result = invitableMembers(members, 'organizer');
    expect(result.map((m) => m.id)).toEqual(['u1']);
  });

  it('keeps everyone when there is no current user id (e.g. still loading auth)', () => {
    const members = [member({ id: 'u1' }), member({ id: 'u2' })];
    expect(invitableMembers(members, undefined)).toHaveLength(2);
  });

  it('sorts alphabetically by first name, then last name, regardless of input order', () => {
    const members = [
      member({ id: 'u3', first_name: 'Bea', last_name: 'Zulu' }),
      member({ id: 'u1', first_name: 'Alice', last_name: 'Zeta' }),
      member({ id: 'u2', first_name: 'Alice', last_name: 'Alpha' }),
    ];
    const result = invitableMembers(members, undefined);
    expect(result.map((m) => m.id)).toEqual(['u2', 'u1', 'u3']);
  });

  it('never mutates the input array', () => {
    const members = [member({ id: 'b', first_name: 'B' }), member({ id: 'a', first_name: 'A' })];
    const original = [...members];
    invitableMembers(members, undefined);
    expect(members).toEqual(original);
  });
});
