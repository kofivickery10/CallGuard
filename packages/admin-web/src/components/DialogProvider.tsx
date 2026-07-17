import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // Red confirm button for destructive/high-impact actions (impersonate, reset 2FA, etc).
  danger?: boolean;
}

interface NotifyOptions {
  title?: string;
}

interface DialogContextValue {
  // Replaces window.confirm — resolves true/false instead of blocking the thread.
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  // Replaces window.alert.
  notify: (message: string, options?: NotifyOptions) => Promise<void>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

type DialogState =
  | { kind: 'confirm'; message: string; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'notify'; message: string; options: NotifyOptions; resolve: () => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState | null>(null);

  const confirm = useCallback((message: string, options: ConfirmOptions = {}) => {
    return new Promise<boolean>((resolve) => {
      setState({ kind: 'confirm', message, options, resolve });
    });
  }, []);

  const notify = useCallback((message: string, options: NotifyOptions = {}) => {
    return new Promise<void>((resolve) => {
      setState({ kind: 'notify', message, options, resolve });
    });
  }, []);

  const close = (result: boolean) => {
    if (!state) return;
    if (state.kind === 'confirm') state.resolve(result);
    else state.resolve();
    setState(null);
  };

  return (
    <DialogContext.Provider value={{ confirm, notify }}>
      {children}
      {state && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto py-8">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => close(false)}
          />
          <div className="relative bg-card border border-border rounded-card w-full max-w-sm p-6 shadow-lg my-auto">
            {state.options.title && (
              <h3 className="text-section-title text-text-primary mb-2">{state.options.title}</h3>
            )}
            <p className="text-table-cell text-text-secondary whitespace-pre-line mb-5">{state.message}</p>
            <div className="flex gap-2 justify-end">
              {state.kind === 'confirm' && (
                <button
                  onClick={() => close(false)}
                  className="px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors"
                >
                  {state.options.cancelLabel ?? 'Cancel'}
                </button>
              )}
              <button
                onClick={() => close(true)}
                autoFocus
                className={`px-[18px] py-[9px] rounded-btn font-semibold text-table-cell text-white transition-colors ${
                  state.kind === 'confirm' && state.options.danger
                    ? 'bg-fail hover:opacity-90'
                    : 'bg-primary hover:bg-primary-hover'
                }`}
              >
                {state.kind === 'confirm' ? (state.options.confirmLabel ?? 'Confirm') : 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within a DialogProvider');
  return ctx;
}
