# Spott iOS 26 Native Visual Specification

Status: required implementation and simulator-review reference for the native iOS app

## Platform boundary

- Build the product in Swift and SwiftUI for iOS 26. Do not use a WebView, HTML/CSS layout, or port the responsive-Web screen pixel-for-pixel.
- Use native `TabView`, one `NavigationStack` per tab, SwiftUI sheets, toolbars, search, controls, menus, and MapKit.
- The responsive mobile Web concept is not an iOS visual reference. The two clients share product facts, task flow, semantics, and brand restraint—not their chrome or layout primitives.
- The decisive visual evidence is a real iOS 26 Simulator capture, not a generated mockup.

## Native composition

- Use the system tab bar for discover, groups, create, itinerary, and profile. On iPhone it minimizes on downward scrolling with `.tabBarMinimizeBehavior(.onScrollDown)` and returns through normal system behavior.
- Each tab owns its navigation history. Titles, back behavior, swipe-to-go-back, sheets, menus, keyboard avoidance, and safe areas remain system-native.
- Discovery begins with a compact navigation title/search treatment and a horizontally scrollable set of high-value filters. Results start immediately after the controls; there is no marketing hero.
- List/map switching is a native segmented control or toolbar action. Map mode uses SwiftUI `Map`, real coordinates, native markers/annotations, and an equivalent detented result sheet.
- Event detail uses a readable content scroll with one bottom safe-area action. Registration uses native form controls and sheets or pushed steps according to length. Confirmation is a full native state, never only a toast.

## Liquid Glass rules

- Prefer system components because iOS 26 applies its own Liquid Glass appearance to navigation, tab bars, sheets, menus, and controls.
- Apply custom glass only to floating interactive chrome such as a compact filter cluster, map/list control, or bottom event action—not to every content card or the full scrolling canvas.
- Group nearby custom effects in `GlassEffectContainer` for coherent blending and rendering. Use `.glassEffect(.regular.interactive(), in: ...)` only when the surface is truly interactive.
- Use `.buttonStyle(.glass)` for secondary glass actions and `.buttonStyle(.glassProminent)` for the single primary glass action when hierarchy requires it. Do not combine glass with competing fake blur, hard gradient borders, or decorative shadows.
- Apply `glassEffect` after modifiers that define the content appearance and shape. Keep the number of simultaneous custom glass surfaces small to protect scrolling performance.
- When several glass controls transition as a family, give them stable effect identities and purposeful system animation; no ornamental looping motion.

## Content surfaces and brand

- Event rows/cards remain content-first, using semantic system backgrounds, separators, real cover imagery, and category fallbacks. They are not translucent glass tiles stacked over imagery.
- Twilight purple is an accent for selection, dates, focus, and one main action. Mint, amber, coral, and danger retain their factual meanings from design tokens.
- Use SF Symbols and semantic Dynamic Type styles. Chinese, Japanese, and English may wrap naturally; never shrink one locale to force visual parity.
- Render only server-backed facts: public location precision, structured fees, format, confirmed/unconfirmed language, organizer phone verification, completed-event count, attendance band, remaining capacity, waitlist, and viewer state.

## Native state and interaction quality

- Search is cancellable and debounced; refresh retains cached results and presents a non-blocking native error surface.
- Loading placeholders keep stable geometry. Empty, offline, permission, and unavailable states each offer one clear recovery action.
- Every hit target is at least 44 pt. VoiceOver receives a concise reading order and equivalent list access for map results.
- Support Dynamic Type through the largest accessibility sizes, Reduce Motion, Reduce Transparency, Increase Contrast, light/dark appearance, keyboard dismissal, and one-handed safe-area reachability.
- Exact addresses remain hidden until permission/registration state authorizes them. Approximate map markers identify themselves as approximate.

## Simulator fidelity gates

- Review real iOS 26 Simulator screenshots for discovery list, map with detented results, event detail, registration, confirmation, and itinerary.
- Capture `zh-Hans`, `ja`, and `en`; light and dark; one largest accessibility Dynamic Type pass; Reduce Motion and Reduce Transparency behavior.
- Block completion for a custom fake tab dock, Web-style navigation, glass on every card, clipped localized copy, hidden final content behind the action bar, fabricated facts, invented coordinates, or non-native modal behavior.
- Run the journey with real API fixtures and test both 390-ish compact iPhone width and a larger iPhone. Visual polish is evaluated together with gesture, keyboard, loading, error, and navigation behavior.
