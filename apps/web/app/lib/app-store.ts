export const appStoreStates = ["unavailable", "preorder", "available"] as const;

export type AppStoreState = (typeof appStoreStates)[number];

type Environment = Readonly<Record<string, string | undefined>>;

export type AppStoreAvailability =
  | {
      readonly state: "unavailable";
      readonly id: null;
      readonly url: null;
    }
  | {
      readonly state: "preorder" | "available";
      readonly id: string;
      readonly url: string;
    };

const appStoreIDPattern = /^[1-9]\d*$/u;
const appStorePathIDPattern = /(?:^|\/)id([1-9]\d*)(?:\/|$)/u;

function unavailable(): AppStoreAvailability {
  return { state: "unavailable", id: null, url: null };
}

function configuredState(value: string | undefined): AppStoreState | null {
  return appStoreStates.find((state) => state === value) ?? null;
}

function validatedAppStoreURL(rawURL: string, expectedID: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawURL);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "apps.apple.com"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.port !== ""
    || parsed.hash !== ""
  ) {
    return null;
  }

  const pathID = appStorePathIDPattern.exec(parsed.pathname)?.[1];
  if (pathID !== expectedID) return null;
  return parsed.toString();
}

export function resolveAppStoreAvailability(environment: Environment): AppStoreAvailability {
  const state = configuredState(environment.NEXT_PUBLIC_APP_STORE_STATE);
  if (state === null || state === "unavailable") return unavailable();

  const id = environment.NEXT_PUBLIC_APP_STORE_ID?.trim() ?? "";
  const rawURL = environment.NEXT_PUBLIC_APP_STORE_URL?.trim() ?? "";
  if (!appStoreIDPattern.test(id) || rawURL === "") return unavailable();

  const url = validatedAppStoreURL(rawURL, id);
  if (url === null) return unavailable();
  return { state, id, url };
}

export function appStoreAvailability(): AppStoreAvailability {
  return resolveAppStoreAvailability(process.env);
}
