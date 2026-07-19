// Minimal in-app toast store. Same listener-set idiom as
// subscribeConnectionState/getConnectionState in sync.ts, generic enough to
// be reused by anything else in the app later -- not chat-specific despite
// being introduced here.

export type ToastTone = 'info' | 'chat';

export interface ToastAction {
  label: string;
  context?: Record<string, unknown>;
}

export interface Toast {
  id: string;
  title: string;
  body?: string;
  tone: ToastTone;
  action?: ToastAction;
}

export interface ShowToastInput {
  title: string;
  body?: string;
  tone?: ToastTone;
  action?: ToastAction;
  durationMs?: number;
}

const DEFAULT_DURATION_MS = 4_500;

let toasts: Toast[] = [];
const listeners = new Set<(toasts: Toast[]) => void>();

function notify(): void {
  listeners.forEach((listener) => listener(toasts));
}

export function getToasts(): Toast[] {
  return toasts;
}

export function subscribeToasts(listener: (toasts: Toast[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

export function showToast(input: ShowToastInput): string {
  const id = crypto.randomUUID();
  toasts = [...toasts, { id, title: input.title, body: input.body, tone: input.tone ?? 'info', action: input.action }];
  notify();

  if (typeof window !== 'undefined') {
    window.setTimeout(() => dismissToast(id), input.durationMs ?? DEFAULT_DURATION_MS);
  }

  return id;
}
