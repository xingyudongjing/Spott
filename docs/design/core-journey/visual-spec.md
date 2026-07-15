# Spott Responsive Web Core Journey Visual Specification

Status: accepted implementation reference for desktop and mobile Web only

## Reference images

- Desktop discovery, 1536 × 1024: `web-discovery-desktop-concept.png`
- Responsive mobile Web discovery, 390 × 844: `discovery-mobile-concept.png`

The first mobile Web concept was rejected because its first event began below 360 px. The checked-in mobile Web reference above is the compact revision: event media begins around 210 px, while search, filters, list/map switching, and the safe-area dock remain available.

This reference must not be reused as the iOS design. Native iOS follows `ios26-native-visual-spec.md`, SwiftUI system navigation, MapKit, sheets, and iOS 26 Liquid Glass instead of reproducing responsive-Web cards or a custom browser-style dock.

These images specify composition and hierarchy. They are not production screenshots and must never be shipped as UI. Photography shown in the concept represents the `coverURL` role only; production renders a real event cover or the existing quiet category fallback and never invents event photography.

## Direction: Quiet Confidence

- Canvas is warm and low-contrast; content surfaces are crisp paper.
- Twilight purple identifies brand, focus, selected filters, dates, and the single primary action.
- Mint appears only for true availability, verification, and success.
- Amber appears only for unconfirmed language, waitlist, or warning.
- Coral appears only for the central create action and scarce/high-attention states.
- Borders and spacing carry most hierarchy. Shadows are subtle and reserved for sticky/elevated layers.
- No giant hero, decorative eyebrow, fake metric, glass stack, gradient ornament, nested card grid, or social-proof avatar row.

## Token lock

All colors, radii, spacing, type, and motion map to `packages/design-tokens/src/tokens.json` and `tokens.css`:

```text
light: canvas #F7F5F0, surface #FFFFFF, ink #17181C, muted #6F737C,
       twilight #6E5BE7, coral #FF745F, mint #3DBD91,
       amber #D99A2B, danger #D84B5B, divider #E6E2DA
dark:  canvas #0E1014, surface #171A20, ink #F7F6F2, muted #A7ACB7,
       twilight #9B8CFF, coral #FF866F, mint #51D4A5,
       amber #F0B84F, danger #FF6B79, divider #2B3038
spacing: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64
radii: control 12, card 18, cover 24, panel 28
motion: 120 / 220 / 360 ms; 1 ms under reduced motion
```

Typography uses the existing Inter Variable → Noto Sans SC → Noto Sans JP → system stack. UI controls never rely on browser-default typography. Chinese, Japanese, and English share one scale and may wrap; no locale-specific shrinking.

## Desktop discovery

- Header is quiet, one row, with brand/region on the left, four core destinations centered, and locale/notification/account plus one create action on the right.
- Content is a single open column inside a wide centered container; no outer rounded dashboard shell.
- The compact promise and supporting sentence lead immediately into search. Search and region occupy most width; list/map is a two-state segmented control.
- Common filters form one horizontal row. More filters owns the advanced popover/sheet. Clear is a quiet text action.
- Results use one bordered list surface. Each row has a stable cover frame, date/time, title, facts, organizer trust facts, true availability, and one chevron. Rows are not separate floating cards.
- Event cover role: real `coverURL`; otherwise the category fallback. No concept photography is copied into seed data.
- Map mode replaces the main result region only when a style URL exists; it keeps an equivalent list/preview and the same URL-driven filters.

## Responsive mobile Web discovery

- Target reference is 390 × 844. It must also work at 360 px width and 200% browser zoom.
- Compact top line: brand, region, notification. Search follows immediately.
- Primary chips scroll horizontally in one row. They never wrap into a tall filter wall.
- Section heading and list/map switch share a row.
- The first real event cover or title begins by y = 330 at the latest; target is approximately y = 210–260 at 390 × 844.
- Event cards use one strong media frame and a compact fact stack. Only real trust facts and real remaining capacity appear.
- Bottom dock has five items—discover, groups, create, itinerary, profile—and includes `env(safe-area-inset-bottom)`. The center create action may use coral, but does not visually compete with the page's event CTA.

## Visible copy lock

Visible strings come from i18n keys and preserve these meanings in `zh-Hans`, `ja`, and `en`:

```text
navigation: discover, groups, itinerary, host, create, profile, notifications, locale
discovery: local-events promise, supporting trust sentence, search placeholder,
           region, this weekend, available, format, price, language,
           more filters, clear, list, map, result count, sort
event facts: date/time, public area, fee, format, language confirmed/unconfirmed,
             organizer name, verified phone only when true, completed event count,
             attendance band only when available, available capacity, waitlist/status
states: loading, empty, stale refresh error, offline, permission, unavailable
```

Do not add “recommended for you,” friend attendance, participant avatars, ratings, or verification claims without matching server facts.

## Interaction and state inventory

- Search: 300 ms debounce, cancels previous request, visible clear action.
- Filters: selected/unselected, hover, focus-visible, pressed, disabled; state round-trips through URL/API query.
- List/map: selected state uses border + text/icon, never color alone.
- Event row/card: whole item is one link target; nested favorite/share actions must not create invalid nested controls.
- Loading: stable skeleton dimensions, no layout jump.
- Refresh error with content: retain content and announce a non-blocking live message.
- Empty/error/offline/permission: one clear next action and no fabricated results.
- Map missing config: hide map choice rather than display an empty panel.

## Icon and image treatment

- Icons are simple, optical 18–22 px, rounded outline, approximately 1.5–1.75 px stroke, `currentColor`, aligned to text baselines.
- Selected navigation may use a filled compass/calendar variant when it remains legible in both themes.
- Cover images use stable aspect ratios, correct responsive sizes, focal cropping, alt text, and a reserved placeholder to prevent CLS.
- Concept images are QA references only. They do not authorize fake covers, fake avatars, or generated event photos.

## Fidelity gates

- Compare browser screenshots against both reference images at their native dimensions with `view_image`.
- Check at least: header density, first-event vertical position, search/filter geometry, type hierarchy, surface/border treatment, event fact order, list/map selected state, and safe-area dock.
- Verify 390, 768, and 1440 px; light/dark; `zh-Hans`, `ja`, and `en`; keyboard focus and reduced motion.
- A functional pass is not a visual pass. Any clipped content, default-looking control, invented copy, fake fact, or first event below the mobile y = 330 gate blocks completion.
