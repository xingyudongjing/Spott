const rfc3339DateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isRFC3339DateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = rfc3339DateTime.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumDay = month === 2 && leapYear ? 29 : monthDays[month - 1]!;
  return day >= 1 && day <= maximumDay;
}
