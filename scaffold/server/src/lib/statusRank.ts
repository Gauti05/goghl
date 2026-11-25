/**
 * Monotonic outbound status rank.
 * Higher rank always wins; terminal states (delivered, failed) are never downgraded.
 */
export const STATUS_RANK: Record<string, number> = {
  queued: 1,
  processing: 1,
  sent: 2,
  delivered: 3,
  failed: 3,
};

export function getStatusesBelowRank(rank: number): string[] {
  return Object.entries(STATUS_RANK)
    .filter(([, r]) => r < rank)
    .map(([s]) => s);
}

export function canUpgradeStatus(currentStatus: string, newStatus: string): boolean {
  const currentRank = STATUS_RANK[currentStatus] ?? 0;
  const newRank = STATUS_RANK[newStatus];
  if (newRank === undefined) return false;
  return newRank > currentRank;
}
