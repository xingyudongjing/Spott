import Image from "next/image";

import styles from "./EventCover.module.css";

interface CoverEvent {
  title: string;
  category: string;
  coverURL?: string | null;
}

export function EventCover({
  event,
  large = false,
  priority = false,
  sizes,
  className = "",
}: {
  event: CoverEvent;
  large?: boolean;
  priority?: boolean;
  sizes?: string;
  className?: string;
  locale?: string;
}) {
  const rootClassName = `${styles.root}${large ? ` ${styles.large}` : ""}${className ? ` ${className}` : ""}`;
  if (event.coverURL) {
    return (
      <div className={rootClassName} data-testid="event-cover-photo">
        <Image
          src={event.coverURL}
          alt={event.title}
          fill
          priority={priority}
          sizes={sizes ?? (large ? "(max-width: 780px) 100vw, 60vw" : "(max-width: 780px) 100vw, 232px")}
          className={styles.image}
        />
      </div>
    );
  }
  return (
    <div
      className={`${rootClassName} ${styles.fallback}`}
      data-category={event.category}
      data-testid="event-cover-fallback"
      role="img"
      aria-label={event.title}
    >
      <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <path className={styles.horizon} d="M18 131c35-18 68-8 96-25 27-16 51-44 90-37 35 6 51 34 98 24" />
        <path className={styles.orbit} d="M83 111c14-59 85-85 137-44 34 27 29 79-5 99" />
        <circle className={styles.sun} cx="220" cy="55" r="18" />
        <path className={styles.trace} d="M21 146h278M42 158h212M121 39l-5 82m38-102 3 112m31-92-7 78" />
      </svg>
    </div>
  );
}
