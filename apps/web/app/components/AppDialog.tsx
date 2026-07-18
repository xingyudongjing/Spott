"use client";

import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "./I18nProvider";

export type AppDialogInput = {
  label: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  minLength?: number;
  maxLength?: number;
};

export type AppDialogRequest = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

export type AppDialogAction = AppDialogRequest & {
  input?: AppDialogInput;
  onConfirm: (value: string) => void | Promise<void>;
};

type PendingDialog = AppDialogRequest & {
  mode: "boolean" | "text" | "action";
  input?: AppDialogInput;
  onConfirm?: AppDialogAction["onConfirm"];
  resolve: (value: boolean | string | null) => void;
};

type AppDialogController = {
  ask: (request: AppDialogRequest) => Promise<boolean>;
  askForText: (request: AppDialogRequest & { input: AppDialogInput }) => Promise<string | null>;
  run: (request: AppDialogAction) => Promise<boolean>;
  dismiss: () => void;
};

const AppDialogContext = createContext<AppDialogController | null>(null);

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingRef = useRef<PendingDialog | null>(null);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);

  const dismissCurrent = useCallback(() => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    busyRef.current = false;
    setBusy(false);
    current.resolve(current.mode === "text" ? null : false);
    setDialog(null);
    setError("");
  }, []);

  const present = useCallback((next: PendingDialog) => {
    const previous = pendingRef.current;
    if (previous) previous.resolve(previous.mode === "text" ? null : false);
    pendingRef.current = next;
    setInputValue(next.input?.defaultValue ?? "");
    setError("");
    setBusy(false);
    busyRef.current = false;
    setDialog(next);
  }, []);

  const ask = useCallback((request: AppDialogRequest): Promise<boolean> => new Promise((resolve) => {
    present({ ...request, mode: "boolean", resolve: (value) => resolve(value === true) });
  }), [present]);

  const askForText = useCallback((request: AppDialogRequest & { input: AppDialogInput }): Promise<string | null> => new Promise((resolve) => {
    present({ ...request, mode: "text", resolve: (value) => resolve(typeof value === "string" ? value : null) });
  }), [present]);

  const run = useCallback((request: AppDialogAction): Promise<boolean> => new Promise((resolve) => {
    present({ ...request, mode: "action", resolve: (value) => resolve(value === true) });
  }), [present]);

  const controller = useMemo(
    () => ({ ask, askForText, run, dismiss: dismissCurrent }),
    [ask, askForText, dismissCurrent, run],
  );

  useEffect(() => () => {
    const current = pendingRef.current;
    if (current) current.resolve(current.mode === "text" ? null : false);
  }, []);

  useEffect(() => {
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial = dialog.input
      ? dialogRef.current?.querySelector<HTMLElement>("textarea:not([disabled]), input:not([disabled])")
      : dialogRef.current?.querySelector<HTMLElement>("button:not([disabled])");
    initial?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      const container = dialogRef.current;
      if (event.key === "Escape") {
        if (busyRef.current) return;
        event.preventDefault();
        dismissCurrent();
        return;
      }
      if (event.key !== "Tab" || !container) return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (activeIndex === -1) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeIndex === 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [dialog, dismissCurrent]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = pendingRef.current;
    if (!current || busyRef.current) return;
    const value = current.input ? inputValue.trim() : "";
    const requiredLength = current.input?.minLength ?? (current.input?.required ? 1 : 0);
    if (value.length < requiredLength) {
      setError(dialogCopy(locale).inputTooShort(requiredLength));
      return;
    }
    setBusy(true);
    busyRef.current = true;
    setError("");
    try {
      await current.onConfirm?.(value);
      if (pendingRef.current !== current) return;
      setBusy(false);
      busyRef.current = false;
      pendingRef.current = null;
      current.resolve(current.mode === "text" ? value : true);
      setDialog(null);
    } catch (cause) {
      if (pendingRef.current !== current) return;
      setError(cause instanceof Error ? cause.message : dialogCopy(locale).error);
    } finally {
      if (pendingRef.current === current) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }

  function requestDismiss() {
    if (busy) return;
    dismissCurrent();
  }

  const copy = dialogCopy(locale);

  return (
    <AppDialogContext.Provider value={controller}>
      {children}
      {dialog && (
        <div
          className="app-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) requestDismiss();
          }}
        >
          <section
            ref={dialogRef}
            className="app-dialog"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-labelledby="app-dialog-title"
            aria-describedby={dialog.message ? "app-dialog-message" : undefined}
          >
            <form onSubmit={submit}>
              <header>
                <div>
                  <span>SPOTT</span>
                  <h2 id="app-dialog-title">{dialog.title}</h2>
                </div>
                <button
                  type="button"
                  className="app-dialog-close"
                  aria-label={copy.close}
                  disabled={busy}
                  onClick={requestDismiss}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </header>
              <div className="app-dialog-body">
                {dialog.message && <p id="app-dialog-message">{dialog.message}</p>}
                {dialog.input && (
                  <label>
                    <span>{dialog.input.label}</span>
                    {dialog.input.multiline ? (
                      <textarea
                        autoFocus
                        value={inputValue}
                        placeholder={dialog.input.placeholder}
                        required={dialog.input.required}
                        minLength={dialog.input.minLength}
                        maxLength={dialog.input.maxLength}
                        onChange={(event) => setInputValue(event.target.value)}
                      />
                    ) : (
                      <input
                        autoFocus
                        value={inputValue}
                        placeholder={dialog.input.placeholder}
                        required={dialog.input.required}
                        minLength={dialog.input.minLength}
                        maxLength={dialog.input.maxLength}
                        onChange={(event) => setInputValue(event.target.value)}
                      />
                    )}
                  </label>
                )}
                {error && <p className="app-dialog-error" role="alert">{error}</p>}
              </div>
              <footer className="app-dialog-actions">
                <button type="button" disabled={busy} onClick={requestDismiss}>
                  {dialog.cancelLabel ?? copy.cancel}
                </button>
                <button className={dialog.destructive ? "danger" : "primary"} disabled={busy} type="submit">
                  {busy ? copy.working : dialog.confirmLabel ?? copy.continue}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </AppDialogContext.Provider>
  );
}

export function useAppDialog(): AppDialogController {
  const value = useContext(AppDialogContext);
  if (!value) throw new Error("useAppDialog must be used inside AppDialogProvider");
  return value;
}

function dialogCopy(locale: "zh-Hans" | "ja" | "en") {
  if (locale === "ja") return { cancel: "キャンセル", continue: "確認", close: "閉じる", working: "処理中…", error: "操作を完了できませんでした。", inputTooShort: (length: number) => `${length}文字以上入力してください。` };
  if (locale === "en") return { cancel: "Cancel", continue: "Confirm", close: "Close", working: "Working…", error: "The action could not be completed.", inputTooShort: (length: number) => `Enter at least ${length} characters.` };
  return { cancel: "取消", continue: "确认", close: "关闭", working: "处理中…", error: "操作未能完成。", inputTooShort: (length: number) => `请至少输入 ${length} 个字符。` };
}
