import { beforeEach, describe, expect, test, vi } from "vitest";

import { headers } from "next/headers";
import { searchEvents } from "../app/lib/events-api";
import { searchEventsForRequest } from "../app/lib/events-server";
import { makePage } from "./event-fixtures";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("../app/lib/events-api", () => ({ searchEvents: vi.fn() }));

const headersMock = vi.mocked(headers);
const searchEventsMock = vi.mocked(searchEvents);

beforeEach(() => {
  headersMock.mockReset();
  searchEventsMock.mockReset();
});

describe("server discovery request boundary", () => {
  test("forwards only the incoming cookie to the first-party API", async () => {
    headersMock.mockResolvedValue(new Headers({
      cookie: "spott_locale=ja; __Host-spott_session=signed-session",
      authorization: "Bearer untrusted-page-header",
      host: "spott.jp",
      "x-forwarded-for": "203.0.113.10",
    }));
    searchEventsMock.mockResolvedValue(makePage());

    await searchEventsForRequest({ region: "tokyo" });

    expect(searchEventsMock).toHaveBeenCalledWith(
      { region: "tokyo" },
      { cookie: "spott_locale=ja; __Host-spott_session=signed-session" },
    );
  });
});
