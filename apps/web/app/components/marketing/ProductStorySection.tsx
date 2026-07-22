import type { ReactNode } from "react";

import styles from "./marketing-home.module.css";

type ProductStorySectionProps = {
  readonly body: string;
  readonly children: ReactNode;
  readonly id: "community" | "cross-surface";
  readonly title: string;
  readonly variant: "community" | "cross";
};

export function ProductStorySection({
  body,
  children,
  id,
  title,
  variant,
}: ProductStorySectionProps) {
  const headingID = `${id}-heading`;
  return (
    <section
      aria-labelledby={headingID}
      className={`${styles.storySection} ${variant === "community" ? styles.communitySection : styles.crossSection}`}
      id={id}
    >
      <div className={styles.storyInner}>
        <div className={styles.storyCopy}>
          <h2 className={styles.sectionTitle} id={headingID}>{title}</h2>
          <p className={styles.sectionBody}>{body}</p>
        </div>
        <div className={styles.storyVisual}>{children}</div>
      </div>
    </section>
  );
}
