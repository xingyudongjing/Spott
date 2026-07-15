"use client";

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
  const hasDate = Boolean(query.startsAfter || query.startsBefore);
  const toggleWeekend = () => {
    if (hasDate) {
      onPatch({ startsAfter: undefined, startsBefore: undefined });
      return;
    }
    onPatch(resolveDateShortcut("this_weekend", "Asia/Tokyo"));
  };

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

      <details className={styles.moreFilters}>
        <summary><SlidersIcon />{t("discover.moreFilters")}</summary>
        <div className={styles.advancedPanel}>
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
      </details>
      <button className={styles.desktopClear} type="button" onClick={onReset}>
        {t("common.clear")}
      </button>
    </div>
  );
}
