# Core journey screenshot matrix

This file is the durable review record for the generated Web and native iOS evidence. Do not mark a row pass from a unit test or mock render; it requires the isolated real-stack command described in [`core-journey/README.md`](core-journey/README.md).

## Web matrix

| Locale | Scheme | 390×844 | 768×1024 | 1440×1024 |
|---|---|---:|---:|---:|
| zh-Hans | Light | Pending run | Pending run | Pending run |
| ja | Light | Pending run | Pending run | Pending run |
| en | Light | Pending run | Pending run | Pending run |

Each cell represents five screenshots: discovery, detail, registration, confirmation, and authoritative itinerary (45 Web screenshots total). Per the latest handoff requirement, Web and Ops are light-only; high-contrast, forced-colors, keyboard, and Reduce Motion remain separate required evidence.

## Required journey evidence

| Evidence | Expected result | Status |
|---|---|---|
| Automatic registration | `confirmed`, visible in Upcoming | Pending run |
| Approval registration | `pending`, visible in Pending | Pending run |
| Full event | `waitlisted`, visible in Waitlist | Pending run |
| Event changes after quote | 409 refresh plus explicit reconfirmation | Pending run |
| Discovery resilience | loading, empty, offline stale-content recovery | Pending run |
| Accessibility behavior | keyboard itinerary tabs and Reduce Motion | Pending run |
| Fixture safety | non-`_test` database rejected | Automated guard implemented; full run pending |

## Native iOS matrix

| Locale | Appearance | Small iPhone | Large iPhone | Largest Dynamic Type | Reduce Motion |
|---|---|---:|---:|---:|---:|
| zh-Hans | Light | Pending run | Pending run | Pending run | Pending run |
| zh-Hans | Dark | Pending run | Pending run | Pending run | Pending run |
| ja | Light | Pending run | Pending run | Pending run | Pending run |
| ja | Dark | Pending run | Pending run | Pending run | Pending run |
| en | Light | Pending run | Pending run | Pending run | Pending run |
| en | Dark | Pending run | Pending run | Pending run | Pending run |

## Signed run record

- Commit: pending final implementation commit
- Web command: pending
- iOS command: pending
- PostgreSQL: 18, isolated database `spott_core_journey_e2e_test`
- Browser/simulator: pending run metadata
- Automated result: pending
- Human reviewer: pending
- Review decision: pending
