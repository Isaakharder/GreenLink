import { useSyncExternalStore } from 'react';
import { getConnectionState, subscribeConnectionState, type ConnectionState } from '../lib/sync';

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribeConnectionState, getConnectionState, getConnectionState);
}
