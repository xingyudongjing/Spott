"use client";

import { useState } from "react";

import type { GroupView } from "../../lib/client-api";
import styles from "./GroupDetail.module.css";

export function GroupDetailArtwork({ group }: { group: GroupView }) {
  const [imageFailed, setImageFailed] = useState(false);

  if (group.coverURL && !imageFailed) {
    return (
      <div className={styles.artwork}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={group.coverURL}
          alt=""
          decoding="async"
          fetchPriority="high"
          onError={() => setImageFailed(true)}
        />
      </div>
    );
  }

  const tone = deterministicTone(group.slug);
  const monogram = Array.from(group.name).filter((value) => value.trim()).slice(0, 2).join("");

  return (
    <div className={styles.artwork} data-tone={tone} aria-hidden="true">
      <svg viewBox="0 0 560 360" preserveAspectRatio="xMidYMid slice">
        <circle className={styles.artworkSun} cx="448" cy="70" r="34" />
        <path className={styles.artworkWash} d="M-20 250C90 160 174 310 290 224s206-26 310-82v238H-20Z" />
        <circle className={styles.recordOuter} cx="216" cy="164" r="110" />
        <circle className={styles.recordGroove} cx="216" cy="164" r="78" />
        <circle className={styles.recordGroove} cx="216" cy="164" r="50" />
        <circle className={styles.recordLabel} cx="216" cy="164" r="25" />
        <circle className={styles.recordHole} cx="216" cy="164" r="4" />
        <path className={styles.tonearm} d="M420 62c-25 22-41 70-42 126l-36 46" />
        <circle className={styles.tonearmJoint} cx="420" cy="62" r="17" />
        <path className={styles.tableLine} d="M58 292h444M92 292l-18 68m394-68 18 68" />
      </svg>
      <span className={styles.artworkMonogram}>{monogram}</span>
      <span className={styles.artworkIndex}>SPOTT · {String(tone + 1).padStart(2, "0")}</span>
    </div>
  );
}

function deterministicTone(value: string) {
  return Array.from(value).reduce((result, character) => result + character.codePointAt(0)!, 0) % 4;
}
