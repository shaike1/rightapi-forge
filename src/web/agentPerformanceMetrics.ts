type TimestampValue = Date | string | number;

function timestampMs(value: TimestampValue): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function taskDurationMinutes(
  createdAt: TimestampValue,
  completedAt?: TimestampValue | null,
  now = Date.now()
): number | null {
  const created = timestampMs(createdAt);
  const ended = completedAt == null ? now : timestampMs(completedAt);
  if (!Number.isFinite(created) || !Number.isFinite(ended)) return null;
  return Math.max(0, (ended - created) / 60000);
}
