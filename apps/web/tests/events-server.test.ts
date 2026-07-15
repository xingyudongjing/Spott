import { beforeEach, describe, expect, test, vi } from "vitest";

import { headers } from "next/headers";
import { fetchEvent, searchEvents } from "../app/lib/events-api";
import { fetchEventForRequest, searchEventsForRequest } from "../app/lib/events-server";
import { makeDetail, makePage } from "./event-fixtures";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("../app/lib/events-api", () => ({ searchEvents: vi.fn(), fetchEvent: vi.fn() }));

const headersMock = vi.mocked(headers);
const searchEventsMock = vi.mocked(searchEvents);
const fetchEventMock = vi.mocked(fetchEvent);

beforeEach(() => {
  headersMock.mockReset();
  searchEventsMock.mockReset();
  fetchEventMock.mockReset();
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

  test("uses the same cookie-only boundary for personalized event detail", async () => {
    headersMock.mockResolvedValue(new Headers({
      cookie: "spott_locale=en; __Host-spott_session=signed-session",
      authorization: "Bearer untrusted-page-header",
    }));
    fetchEventMock.mockResolvedValue(makeDetail());

    await fetchEventForRequest("tokyo-afterglow-walk");

    expect(fetchEventMock).toHaveBeenCalledWith(
      "tokyo-afterglow-walk",
      { cookie: "spott_locale=en; __Host-spott_session=signed-session" },
    );
  });
});
