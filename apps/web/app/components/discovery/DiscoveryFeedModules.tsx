"use client";

import type { OrderedDiscoveryFeedModule } from "../../lib/discovery-feed";
import { useI18n } from "../I18nProvider";
import { DiscoveryEmpty } from "./DiscoveryState";
import { EventResultCard } from "./EventResultCard";
import styles from "./DiscoveryShell.module.css";

export function DiscoveryFeedModules({
  modules,
  onReset,
}: {
  readonly modules: OrderedDiscoveryFeedModule[];
  readonly onReset: () => void;
}) {
  const { t } = useI18n();
  if (modules.length === 0) return <DiscoveryEmpty onReset={onReset} />;

  return (
    <div className={styles.recommendationFeed}>
      {modules.map((module, moduleIndex) => (
        <section className={styles.recommendationModule} key={module.key}>
          <header className={styles.recommendationHeader}>
            <h2>{moduleTitle(module.key, t)}</h2>
          </header>
          <div className={styles.recommendationRail}>
            {module.items.map((event, eventIndex) => (
              <EventResultCard
                key={event.id}
                event={event}
                priority={moduleIndex === 0 && eventIndex === 0}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function moduleTitle(
  key: string,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (key === "today") return t("discover.moduleToday");
  if (key === "weekend") return t("discover.moduleWeekend");
  if (key === "nearby_hot") return t("discover.moduleNearbyHot");
  if (key === "interest") return t("discover.moduleInterest");
  if (key === "new_events") return t("discover.moduleNewEvents");
  if (key === "verified_hosts") return t("discover.moduleVerifiedHosts");
  if (key === "followed_updates") return t("discover.moduleFollowedUpdates");
  return t("discover.moduleFallback");
}
