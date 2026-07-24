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

export function ListIcon({ size = 20, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>;
}

export function MapIcon({ size = 20, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="m3.5 5.5 5-2.5 7 2.5 5-2.5v15.5l-5 2.5-7-2.5-5 2.5V5.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M8.5 3v15.5M15.5 5.5V21" stroke="currentColor" strokeWidth="1.6"/></svg>;
}

export function TicketIcon({ size = 18, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M4 6.5h16v4a2.5 2.5 0 0 0 0 5v2H4v-2a2.5 2.5 0 0 0 0-5v-4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M13 8.5v7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1 3"/></svg>;
}

export function GlobeIcon({ size = 18, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6"/><path d="M3.8 12h16.4M12 3.5c2.1 2.3 3.2 5.1 3.2 8.5S14.1 18.2 12 20.5C9.9 18.2 8.8 15.4 8.8 12S9.9 5.8 12 3.5Z" stroke="currentColor" strokeWidth="1.6"/></svg>;
}

export function ShieldCheckIcon({ size = 18, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M12 3.5 19 6v5.4c0 4.5-2.6 7.5-7 9.1-4.4-1.6-7-4.6-7-9.1V6l7-2.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="m8.8 12 2.1 2.1 4.5-4.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export function BuildingIcon({ size = 18, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M5 20V5.5L13 3v17M13 8h6v12M3 20h18M8 8h2M8 12h2M8 16h2M16 11h1M16 15h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export function SlidersIcon({ size = 18, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M4 7h5M15 7h5M4 17h8M18 17h2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><circle cx="12" cy="7" r="3" stroke="currentColor" strokeWidth="1.7"/><circle cx="15" cy="17" r="3" stroke="currentColor" strokeWidth="1.7"/></svg>;
}

export function SortIcon({ size = 16, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M7.5 4.5v15m0 0L4 16m3.5 3.5L11 16M16.5 19.5v-15m0 0L13 8m3.5-3.5L20 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export function ChevronIcon({ size = 18, className }: IconProps = {}) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
