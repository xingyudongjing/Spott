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
  const illustration = fallbackIllustration(event.category);
  return (
    <div
      className={`${rootClassName} ${styles.fallback}`}
      data-category={event.category}
      data-illustration={illustration}
      data-testid="event-cover-fallback"
      role="img"
      aria-label={event.title}
    >
      <FallbackIllustration illustration={illustration} />
    </div>
  );
}

type FallbackIllustrationKind = "city-walk" | "music" | "outdoor" | "community";

function fallbackIllustration(category: string): FallbackIllustrationKind {
  if (["city-walk", "walk", "photography"].includes(category)) return "city-walk";
  if (["music", "art"].includes(category)) return "music";
  if (["outdoor", "wellness", "sports"].includes(category)) return "outdoor";
  return "community";
}

function FallbackIllustration({ illustration }: { illustration: FallbackIllustrationKind }) {
  if (illustration === "music") {
    return (
      <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <circle className={styles.wash} cx="112" cy="92" r="64" />
        <circle className={styles.line} cx="112" cy="92" r="49" />
        <circle className={styles.fine} cx="112" cy="92" r="35" />
        <circle className={styles.accent} cx="112" cy="92" r="10" />
        <path className={styles.line} d="M219 42h45v12h-31v55c0 17-12 29-29 29-13 0-23-8-23-19 0-13 12-22 28-22 4 0 7 .5 10 1.5V42Z" />
        <path className={styles.fine} d="M39 153h242M64 24h80M179 27h64" />
      </svg>
    );
  }
  if (illustration === "outdoor") {
    return (
      <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <circle className={styles.accent} cx="245" cy="45" r="22" />
        <path className={styles.wash} d="m19 134 72-74 42 43 38-31 76 62Z" />
        <path className={styles.line} d="m13 137 78-80 43 45 37-33 87 68" />
        <path className={styles.fine} d="M22 150c29-11 52-11 80 0 28 11 52 11 80 0 28-11 53-11 116 0M44 162c20-7 37-7 57 0 20 7 38 7 58 0 20-7 39-7 59 0" />
      </svg>
    );
  }
  if (illustration === "city-walk") {
    return (
      <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <circle className={styles.accent} cx="244" cy="44" r="20" />
        <path className={styles.wash} d="M20 75h37v53H20zm43-24h38v77H63zm45 37h29v40h-29zm112-14h31v54h-31zm38-37h41v91h-41z" />
        <path className={styles.line} d="M17 129h286M20 75h37v53M63 51h38v77m7-40h29v40m83-54h31v54m7-91h41v91" />
        <path className={styles.fine} d="M28 88h20m23-21h21m-21 15h21m24 17h13m99-13h15m43-31h24m-24 16h24M21 145c42-16 74 16 116 0 42-16 77 16 161 0" />
        <path className={styles.route} d="M39 155c36 11 59-4 79-18 22-16 47-18 69-9 18 8 32 7 50-2" />
        <circle className={styles.routePoint} cx="39" cy="155" r="5" />
        <circle className={styles.routePoint} cx="237" cy="126" r="5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <circle className={styles.wash} cx="160" cy="90" r="72" />
      <circle className={styles.line} cx="111" cy="79" r="25" />
      <circle className={styles.line} cx="209" cy="79" r="25" />
      <path className={styles.line} d="M67 145c4-29 20-44 44-44 25 0 40 15 45 44m8 0c5-29 20-44 45-44 24 0 40 15 44 44" />
      <path className={styles.fine} d="M26 155h268M160 28v124" />
      <circle className={styles.accent} cx="160" cy="77" r="10" />
    </svg>
  );
}
