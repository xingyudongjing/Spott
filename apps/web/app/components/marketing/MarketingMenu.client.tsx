"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import styles from "./marketing-home.module.css";

type NavigationItem = {
  readonly href: string;
  readonly label: string;
};

type LanguageLink = {
  readonly current: boolean;
  readonly href: string;
  readonly label: string;
  readonly locale: string;
};

type MarketingMenuProps = {
  readonly currentLanguage: string;
  readonly languageLabel: string;
  readonly languages: readonly LanguageLink[];
  readonly menuCloseLabel: string;
  readonly menuOpenLabel: string;
  readonly navItems: readonly NavigationItem[];
  readonly navigationLabel: string;
};

function GlobeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.3 2.5 3.5 5.5 3.5 9S14.3 18.5 12 21c-2.3-2.5-3.5-5.5-3.5-9S9.7 5.5 12 3Z" />
    </svg>
  );
}

function MenuIcon({ open }: { readonly open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {open ? <path d="m5 5 14 14M19 5 5 19" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
    </svg>
  );
}

export function MarketingMenu({
  currentLanguage,
  languageLabel,
  languages,
  menuCloseLabel,
  menuOpenLabel,
  navItems,
  navigationLabel,
}: MarketingMenuProps) {
  const [open, setOpen] = useState(false);
  const menuID = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const animationFrame = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>("a[href], button:not([disabled])")?.focus();
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  function closeMenu({ restoreFocus = true } = {}) {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => buttonRef.current?.focus());
  }

  function handlePanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function changeLanguage(event: MouseEvent<HTMLAnchorElement>, href: string) {
    event.preventDefault();
    window.location.assign(`${href}${window.location.hash}`);
  }

  return (
    <div className={styles.menuTools}>
      <details className={styles.languagePicker}>
        <summary aria-label={languageLabel}>
          <GlobeIcon />
          <span>{currentLanguage}</span>
          <svg aria-hidden="true" className={styles.languageChevron} viewBox="0 0 16 16">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </summary>
        <ul>
          {languages.map((language) => (
            <li key={language.locale}>
              <a
                aria-current={language.current ? "page" : undefined}
                href={language.href}
                hrefLang={language.locale}
                lang={language.locale}
                onClick={(event) => changeLanguage(event, language.href)}
              >
                {language.label}
              </a>
            </li>
          ))}
        </ul>
      </details>

      <button
        aria-controls={menuID}
        aria-expanded={open}
        aria-label={open ? menuCloseLabel : menuOpenLabel}
        className={styles.menuToggle}
        onClick={() => setOpen((current) => !current)}
        ref={buttonRef}
        type="button"
      >
        <MenuIcon open={open} />
      </button>

      {open ? (
        <>
          <button
            aria-hidden="true"
            className={styles.menuBackdrop}
            onClick={() => closeMenu()}
            tabIndex={-1}
            type="button"
          />
          <div
            aria-label={navigationLabel}
            aria-modal="true"
            className={styles.mobileMenuPanel}
            id={menuID}
            onKeyDown={handlePanelKeyDown}
            ref={panelRef}
            role="dialog"
          >
            <button
              aria-label={menuCloseLabel}
              className={styles.mobileMenuClose}
              onClick={() => closeMenu()}
              type="button"
            >
              <MenuIcon open />
            </button>
            <nav aria-label={navigationLabel}>
              {navItems.map((item) => (
                <a href={item.href} key={item.href} onClick={() => closeMenu({ restoreFocus: false })}>
                  <span>{item.label}</span>
                  <svg aria-hidden="true" viewBox="0 0 20 20">
                    <path d="M4 10h11M11 5l5 5-5 5" />
                  </svg>
                </a>
              ))}
            </nav>
          </div>
        </>
      ) : null}
    </div>
  );
}
