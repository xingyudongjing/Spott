"use client";

import { useCallback, useId, useRef, useState } from "react";

import {
  resolveDateShortcut,
  type EventDiscoveryQuery,
} from "../../lib/discovery-query";
import { useI18n } from "../I18nProvider";
import { GlobeIcon, PinIcon, SlidersIcon, TicketIcon } from "../icons";
import styles from "./DiscoveryShell.module.css";

const categories = [
  ["", "filter.allCategories"],
  ["city-walk", "filter.categoryWalk"],
  ["music", "filter.categoryMusic"],
  ["food", "filter.categoryFood"],
  ["outdoor", "filter.categoryOutdoor"],
  ["art", "filter.categoryArt"],
  ["language", "filter.categoryLanguage"],
  ["sports", "filter.categorySports"],
  ["games", "filter.categoryGames"],
  ["learning", "filter.categoryLearning"],
  ["wellness", "filter.categoryWellness"],
  ["networking", "filter.categoryNetworking"],
] as const;

export function DiscoveryFilters({
  query,
  onPatch,
  onReset,
}: {
  query: EventDiscoveryQuery;
  onPatch: (patch: Partial<EventDiscoveryQuery>) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogTitleId = useId();
  const hasDate = Boolean(query.startsAfter || query.startsBefore);
  const toggleWeekend = () => {
    if (hasDate) {
      onPatch({ startsAfter: undefined, startsBefore: undefined });
      return;
    }
    onPatch(resolveDateShortcut("this_weekend", "Asia/Tokyo"));
  };
  const closeDialog = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    setDialogOpen(false);
    openerRef.current?.focus();
  }, []);
  const openDialog = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    setDialogOpen(true);
  }, []);
  const startDate = dateInputValue(query.startsAfter);
  const endDate = dateInputValue(query.startsBefore, true);

  return (
    <div className={styles.filters}>
      <div className={styles.filterRail} role="group" aria-label={t("discover.when")}>
        <button type="button" aria-pressed={hasDate} onClick={toggleWeekend}>
          <span aria-hidden="true">▣</span>{t("discover.weekend")}
        </button>
        <button
          type="button"
          aria-pressed={query.availableOnly === true}
          onClick={() => onPatch({ availableOnly: query.availableOnly ? undefined : true })}
        >
          <span aria-hidden="true">♙</span>{t("discover.availability")}
        </button>
        <label>
          <PinIcon />
          <select
            value={query.format ?? ""}
            aria-label={t("discover.format")}
            onChange={(event) => onPatch({ format: event.target.value as EventDiscoveryQuery["format"] || undefined })}
          >
            <option value="">{t("filter.allFormats")}</option>
            <option value="in_person">{t("event.formatInPerson")}</option>
            <option value="online">{t("event.formatOnline")}</option>
            <option value="hybrid">{t("event.formatHybrid")}</option>
          </select>
        </label>
        <label>
          <TicketIcon />
          <select
            value={query.price ?? ""}
            aria-label={t("discover.price")}
            onChange={(event) => onPatch({ price: event.target.value as EventDiscoveryQuery["price"] || undefined })}
          >
            <option value="">{t("filter.allPrices")}</option>
            <option value="free">{t("common.free")}</option>
            <option value="paid">{t("filter.paid")}</option>
          </select>
        </label>
        <label>
          <GlobeIcon />
          <select
            value={query.language ?? ""}
            aria-label={t("discover.language")}
            onChange={(event) => onPatch({ language: event.target.value as EventDiscoveryQuery["language"] || undefined })}
          >
            <option value="">{t("filter.allLanguages")}</option>
            <option value="zh-Hans">{t("event.languageChinese")}</option>
            <option value="ja">{t("event.languageJapanese")}</option>
            <option value="en">{t("event.languageEnglish")}</option>
          </select>
        </label>
      </div>

      <div className={styles.moreFilters}>
        <button
          ref={openerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={dialogOpen}
          onClick={openDialog}
        >
          <SlidersIcon />{t("discover.moreFilters")}
        </button>
        <dialog
          ref={dialogRef}
          className={styles.filterDialog}
          aria-labelledby={dialogTitleId}
          aria-modal="true"
          onClose={() => {
            setDialogOpen(false);
            openerRef.current?.focus();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            closeDialog();
          }}
        >
          <div className={styles.dialogHeader}>
            <strong id={dialogTitleId}>{t("discover.moreFilters")}</strong>
            <button type="button" onClick={closeDialog} aria-label={t("common.close")}>×</button>
          </div>
          <div className={styles.advancedPanel}>
            <div className={styles.dateFields}>
              <label>
                <span>{t("discover.startDate")}</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => {
                    const startsAfter = dateBoundary(event.target.value, false);
                    onPatch({
                      startsAfter,
                      ...(startsAfter && query.startsBefore && Date.parse(startsAfter) > Date.parse(query.startsBefore)
                        ? { startsBefore: undefined }
                        : {}),
                    });
                  }}
                />
              </label>
              <label>
                <span>{t("discover.endDate")}</span>
                <input
                  type="date"
                  min={startDate || undefined}
                  value={endDate}
                  onChange={(event) => onPatch({ startsBefore: dateBoundary(event.target.value, true) })}
                />
              </label>
            </div>
          <label>
            <span>{t("discover.category")}</span>
            <select
              value={query.category ?? ""}
              aria-label={t("discover.category")}
              onChange={(event) => onPatch({ category: event.target.value || undefined })}
            >
              {categories.map(([value, key]) => (
                <option key={value || "all"} value={value}>{t(key)}</option>
              ))}
            </select>
          </label>
            <button type="button" onClick={onReset}>{t("common.clear")}</button>
          </div>
        </dialog>
      </div>
      <button className={styles.desktopClear} type="button" onClick={onReset}>
        {t("common.clear")}
      </button>
    </div>
  );
}

function dateBoundary(value: string, exclusiveEnd: boolean) {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(Date.UTC(year, month - 1, day + (exclusiveEnd ? 1 : 0), -9)).toISOString();
}

function dateInputValue(value: string | undefined, exclusiveEnd = false) {
  if (!value) return "";
  const local = new Date(Date.parse(value) + 9 * 60 * 60 * 1000);
  if (exclusiveEnd) local.setUTCDate(local.getUTCDate() - 1);
  return local.toISOString().slice(0, 10);
}
