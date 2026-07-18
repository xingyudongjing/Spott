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
  test("never forwards page credentials to the first-party API", async () => {
    headersMock.mockResolvedValue(new Headers({
      cookie: "spott_locale=ja; __Host-spott_session=signed-session",
      authorization: "Bearer untrusted-page-header",
      host: "spott.jp",
      "x-forwarded-for": "203.0.113.10",
    }));
    searchEventsMock.mockResolvedValue(makePage());

    await searchEventsForRequest({ region: "tokyo" });

    expect(headersMock).not.toHaveBeenCalled();
    expect(searchEventsMock).toHaveBeenCalledWith({ region: "tokyo" });
  });

  test("keeps event detail SSR anonymous even when the page request is authenticated", async () => {
    headersMock.mockResolvedValue(new Headers({
      cookie: "spott_locale=en; __Host-spott_session=signed-session",
      authorization: "Bearer untrusted-page-header",
    }));
    fetchEventMock.mockResolvedValue(makeDetail());

    await fetchEventForRequest("tokyo-afterglow-walk");

    expect(headersMock).not.toHaveBeenCalled();
    expect(fetchEventMock).toHaveBeenCalledWith("tokyo-afterglow-walk");
  });
});
