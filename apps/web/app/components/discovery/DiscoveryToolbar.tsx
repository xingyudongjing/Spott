"use client";

import type { EventDiscoveryQuery } from "../../lib/discovery-query";
import { useI18n } from "../I18nProvider";
import { ListIcon, MapIcon, PinIcon, SearchIcon } from "../icons";
import styles from "./DiscoveryShell.module.css";

const regions = ["", "tokyo", "kanagawa", "saitama", "chiba", "osaka", "kyoto"] as const;

export function DiscoveryToolbar({
  query,
  searchText,
  mode,
  mapEnabled,
  onSearchTextChange,
  onRegionChange,
  onModeChange,
}: {
  query: EventDiscoveryQuery;
  searchText: string;
  mode: "list" | "map";
  mapEnabled: boolean;
  onSearchTextChange: (value: string) => void;
  onRegionChange: (value: string | undefined) => void;
  onModeChange: (mode: "list" | "map") => void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.toolbar}>
      <label className={styles.searchField}>
        <SearchIcon />
        <span className="sr-only">{t("nav.search")}</span>
        <input
          type="search"
          value={searchText}
          onChange={(event) => onSearchTextChange(event.target.value)}
          placeholder={t("discover.searchPlaceholder")}
          autoComplete="off"
        />
        {searchText ? (
          <button
            type="button"
            className={styles.searchClear}
            onClick={() => onSearchTextChange("")}
            aria-label={t("common.clear")}
          >
            ×
          </button>
        ) : null}
      </label>

      <label className={styles.regionField}>
        <PinIcon size={19} />
        <span className="sr-only">{t("discover.region")}</span>
        <select
          value={query.region ?? ""}
          onChange={(event) => onRegionChange(event.target.value || undefined)}
          aria-label={t("discover.region")}
        >
          {regions.map((value) => (
            <option key={value || "all"} value={value}>
              {t(value ? `region.${value}` as "region.tokyo" : "region.all")}
            </option>
          ))}
        </select>
      </label>

      <div
        className={styles.viewSwitch}
        data-map-enabled={mapEnabled}
        aria-label={`${t("discover.list")} / ${t("discover.map")}`}
      >
        <button
          type="button"
          aria-pressed={mode === "list"}
          onClick={() => onModeChange("list")}
        >
          <ListIcon />{t("discover.list")}
        </button>
        {mapEnabled ? (
          <button
            type="button"
            aria-pressed={mode === "map"}
            onClick={() => onModeChange("map")}
          >
            <MapIcon />{t("discover.map")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
