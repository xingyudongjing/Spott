# Core journey evidence

This directory documents the reproducible evidence contract for Spott's shared Web and native iOS journey. Evidence is generated from a fresh PostgreSQL 18 database by the root scripts; screenshots are build artifacts and are intentionally not committed.

## Reproduce

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm test:e2e:core:web
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm test:e2e:core:ios
```

The orchestrator refuses any database whose name does not end in `_test`, recreates `/tmp/spott-core-journey-e2e-pg18`, applies every migration, then seeds relative future events for automatic confirmation, host approval, and a full waitlist. Login and Japanese phone verification use the real development challenge response; there is no test-only authentication endpoint.

## Web artifacts

Playwright writes its HTML report and failure diagnostics under `output/playwright/`. The visual matrix uses:

```text
output/playwright/core-journey/<locale>/<scheme>/<viewport>/
  01-discovery.png
  02-event-detail.png
  03-registration.png
  04-confirmation.png
  05-itinerary.png
```

Locales are `zh-Hans`, `ja`, and `en`; Web uses the required `light` scheme only; viewports are `phone` (390×844), `tablet` (768×1024), and `desktop` (1440×1024). High-contrast, forced-colors, keyboard, and Reduce Motion checks are recorded separately. Native iOS evidence still covers both system light and dark appearances.

## Review contract

Every run must prove all of the following before the matrix can be marked pass:

- discovery, event detail, email login, phone verification, registration, quote, confirmation, and itinerary use the real API and database;
- automatic events become confirmed, approval events become pending, and full events become waitlisted;
- a real event-version conflict requires explicit reconfirmation before submission;
- loading, empty, offline/stale-content, keyboard tab navigation, and Reduce Motion states remain usable;
- each screen has one primary action, no obscured sticky/safe-area content, no clipped translations, and no fabricated coordinate, avatar, trust, fee, or success data;
- browser page errors are empty and responsive screenshots pass human review.

The signed run result, artifact counts, and human-review decision belong in [`../core-journey-screenshot-matrix.md`](../core-journey-screenshot-matrix.md).
