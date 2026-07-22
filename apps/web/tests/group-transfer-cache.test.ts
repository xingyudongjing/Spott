import { beforeEach, describe, expect, test } from "vitest";

import {
  clearAllGroupTransferCaches,
  groupTransferStorageKey,
} from "../app/lib/group-transfer-cache";

beforeEach(() => window.localStorage.clear());

describe("group transfer cache persistence", () => {
  test("uses the existing group-scoped storage namespace", () => {
    expect(groupTransferStorageKey("group-a")).toBe("spott.group-transfer.group-a");
  });

  test("clears every group transfer cache without removing unrelated local state", () => {
    window.localStorage.setItem(groupTransferStorageKey("group-a"), JSON.stringify({ id: "transfer-a" }));
    window.localStorage.setItem(groupTransferStorageKey("group-b"), JSON.stringify({ id: "transfer-b" }));
    window.localStorage.setItem("spott.group-transfer-settings", "keep-me");

    clearAllGroupTransferCaches(window.localStorage);

    expect(window.localStorage.getItem(groupTransferStorageKey("group-a"))).toBeNull();
    expect(window.localStorage.getItem(groupTransferStorageKey("group-b"))).toBeNull();
    expect(window.localStorage.getItem("spott.group-transfer-settings")).toBe("keep-me");
  });
});
