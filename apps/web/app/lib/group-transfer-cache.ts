type GroupTransferCacheStorage = Pick<Storage, "key" | "length" | "removeItem">;

const GROUP_TRANSFER_CACHE_KEY_PREFIX = "spott.group-transfer.";

export function groupTransferStorageKey(groupId: string): string {
  return `${GROUP_TRANSFER_CACHE_KEY_PREFIX}${groupId}`;
}

export function clearAllGroupTransferCaches(storage: GroupTransferCacheStorage): void {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (key?.startsWith(GROUP_TRANSFER_CACHE_KEY_PREFIX)) storage.removeItem(key);
    }
  } catch {
    // Group management remains usable when browser storage is blocked.
  }
}
