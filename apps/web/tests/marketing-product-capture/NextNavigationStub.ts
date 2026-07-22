export function usePathname(): string {
  const surface = new URLSearchParams(window.location.search).get("surface");
  if (surface === "event-detail") return "/e/tokyo-afterglow-sumida-walk";
  if (surface === "groups") return "/groups";
  return "/discover";
}
