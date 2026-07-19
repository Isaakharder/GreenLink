import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { useTournamentChat } from '../../hooks/useTournamentChat';
import { ChatFab } from './ChatFab';
import { ChatPanel } from './ChatPanel';
import type { TournamentAccess } from '../../hooks/useTournamentAccess';

interface TournamentChatProps {
  access: TournamentAccess;
}

/**
 * Mounted once by TournamentDetail (alongside the tab bar/Outlet), so it
 * persists across tab navigation instead of remounting per tab -- the FAB,
 * unread count, and realtime channel all need to survive switching between
 * Overview/Scorecard/Live tabs.
 */
export function TournamentChat({ access }: TournamentChatProps) {
  const { user } = useAuth();
  const { tournament, isAcceptedMember, isOrganizer } = access;

  const [open, setOpen] = useState(false);
  const [openedWithLastReadAt, setOpenedWithLastReadAt] = useState<string | null>(null);

  const chat = useTournamentChat({
    tournamentId: tournament?.id,
    isMember: isAcceptedMember,
    isOrganizer,
    tournamentStatus: tournament?.status,
    tournamentName: tournament?.name ?? '',
    isPanelOpen: open,
  });

  // Never shown for a personal round (My Golf routes never mount this
  // component at all, but the guard is cheap insurance), for a non-member,
  // or before the tournament has started -- see the brief's own offered
  // fallback ("otherwise display 'Chat opens when the tournament starts'"),
  // which the panel itself would show if this were ever reached pre-start.
  if (!tournament || tournament.is_personal || !chat.canRead || chat.availability === 'not-started') {
    return null;
  }

  function handleOpen() {
    setOpenedWithLastReadAt(chat.lastReadAt);
    setOpen(true);
    void chat.markRead();
  }

  return (
    <>
      <ChatFab unreadCount={chat.unreadCount} readOnly={chat.availability !== 'live'} onClick={handleOpen} />
      {open && (
        <ChatPanel
          chat={chat}
          openedWithLastReadAt={openedWithLastReadAt}
          currentUserId={user?.id ?? null}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
