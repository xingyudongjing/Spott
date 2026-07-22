# Spott “Tokyo Afterglow” visual direction proposal

Status: direction proposal, not yet an accepted implementation specification.

## Product intent

This direction makes Spott feel like a contemporary Tokyo culture journal while
remaining a real event-discovery product. It keeps the current real data,
filters, map, organizer trust, capacity, language, calendar, sharing and
registration journeys, then restores the editorial hierarchy that was lost
when iOS and Web were moved onto the authoritative stores.

The design deliberately differs from both benchmarks:

- more editorial and locally distinctive than Meetup's result grid;
- more decision-useful and community-oriented than Luma's sparse discovery;
- less card-heavy and less decorative than a generic generated dashboard.

## Proposal images

- `web-discovery-desktop.png`
- `web-discovery-mobile.png`
- `ios-discovery-native.png`
- `web-event-detail-mobile.png`

## Direction locks

- Canvas: cool porcelain white, not beige.
- Type: graphite, editorial hierarchy, Japanese/Latin parity.
- Accent: disciplined Spott violet with one quiet Tokyo vermilion detail.
- Media: stable editorial event crops; event content is never glass.
- Web: open rails and lists instead of repeated grid cards.
- iOS 26.5: native Liquid Glass only on navigation and interactive controls
  (location, search, filters, map, notifications, primary actions, tab bar).
- Minimum touch targets: 44 points/pixels where applicable.
- Chinese, Japanese and English must survive the same layout and hierarchy.

## Required corrections before visual lock

These generated proposal images communicate direction, not final copy:

1. The third organizer must use authoritative product data; do not ship the
   invented `Kamakura Coast Club` label.
2. Public raw-IP preview must remain read-only. Login/registration actions are
   shown only on the encrypted internal-test or future TLS/domain surface.
3. Mobile Web needs an explicit compact Create entry in the authenticated
   navigation model; it must not disappear behind an ambiguous menu.
4. The event-detail action model must avoid duplicate Share controls and must
   never obscure title or metadata.
5. `本周精选` is allowed only when backed by the discovery-feed selection
   rule; otherwise use a neutral section heading rather than a fake badge.
6. All visible text and controls are code-native. Generated photographs are
   reference media and require licensed, organizer-provided or approved
   production replacements.

## Approval gate

After direction approval, create the exact design tokens, copy lock, component
inventory, responsive states, dark-mode states and iOS accessibility variants.
Only then may the implementation begin.
