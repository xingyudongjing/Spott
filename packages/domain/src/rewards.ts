// Retention rewards are computed from authoritative server facts. The daily
// check-in streak is expressed as pure civil-date arithmetic so it can be unit
// tested independently of the ledger and of any wall-clock. Dates are the
// Asia/Tokyo civil day (`YYYY-MM-DD`) resolved on the server; the service layer
// is responsible for producing `today` from the database clock.

export interface CheckinStreakState {
  /** The last civil day (Asia/Tokyo, `YYYY-MM-DD`) the user checked in. */
  lastCheckinDate: string;
  /** The length of the unbroken streak that ended on `lastCheckinDate`. */
  currentStreak: number;
}

export interface CheckinPlan {
  /** True when the user already claimed today's check-in; nothing is granted. */
  alreadyCheckedIn: boolean;
  /** The streak length after applying today's check-in. */
  newStreak: number;
  /** Whether the base daily reward should be credited. */
  grantDaily: boolean;
  /** Whether the seven-day continuity bonus should be credited. */
  grantStreak7: boolean;
  /** Whether the thirty-day continuity bonus should be credited. */
  grantStreak30: boolean;
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function assertCivilDate(value: string): void {
  if (!CIVIL_DATE.test(value)) {
    throw new TypeError(`预期 YYYY-MM-DD 的自然日，收到 ${value}`);
  }
  if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new TypeError(`无效的自然日 ${value}`);
  }
}

/** Returns the civil day immediately before `date` (`YYYY-MM-DD`, UTC-safe). */
export function previousCivilDate(date: string): string {
  assertCivilDate(date);
  const asUtc = new Date(`${date}T00:00:00Z`);
  asUtc.setUTCDate(asUtc.getUTCDate() - 1);
  return asUtc.toISOString().slice(0, 10);
}

/**
 * Plans the ledger effects of a points-center check-in on `today` given the
 * user's prior streak state. The streak restarts after any gap and the
 * continuity bonuses fire on every seventh/thirtieth consecutive day.
 */
export function planDailyCheckin(previous: CheckinStreakState | null, today: string): CheckinPlan {
  assertCivilDate(today);

  if (previous && previous.lastCheckinDate === today) {
    return {
      alreadyCheckedIn: true,
      newStreak: previous.currentStreak,
      grantDaily: false,
      grantStreak7: false,
      grantStreak30: false,
    };
  }

  const continued = previous !== null && previousCivilDate(today) === previous.lastCheckinDate;
  const newStreak = continued ? previous.currentStreak + 1 : 1;

  return {
    alreadyCheckedIn: false,
    newStreak,
    grantDaily: true,
    grantStreak7: newStreak % 7 === 0,
    grantStreak30: newStreak % 30 === 0,
  };
}
