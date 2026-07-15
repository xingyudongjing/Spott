type IconProps = { size?: number; className?: string };

export function SearchIcon({ size = 20, className }: IconProps) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><circle cx="10.8" cy="10.8" r="6.5" stroke="currentColor" strokeWidth="1.8"/><path d="m15.7 15.7 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>;
}

export function ArrowIcon({ size = 17, className }: IconProps) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M7 17 17 7M8 7h9v9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export function PinIcon({ size = 15, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" stroke="currentColor" strokeWidth="1.7"/><circle cx="12" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.7"/></svg>;
}

export function BellIcon({ size = 20, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8ZM10 21h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export function UsersIcon({ size = 20, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.7"/><path d="M3.5 19c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M15 5.4a3 3 0 0 1 0 5.2M16.5 13.3c2.4.6 3.7 2.5 4 5.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>;
}

export function CalendarIcon({ size = 20, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><rect x="3.5" y="5.5" width="17" height="15" rx="3" stroke="currentColor" strokeWidth="1.7"/><path d="M8 3v5M16 3v5M4 10h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>;
}

export function UserIcon({ size = 20, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.8" stroke="currentColor" strokeWidth="1.7"/><path d="M4.8 20c.6-4.2 3-6.3 7.2-6.3s6.6 2.1 7.2 6.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>;
}
