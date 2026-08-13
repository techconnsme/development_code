export type RelativeBucket =
  | { kind: 'relative'; unit: 'second' | 'minute' | 'hour' | 'day'; value: number }
  | { kind: 'date'; date: string }
  | { kind: 'invalid'; raw: string };

/** Parse the DB's UTC "YYYY-MM-DD HH:MM:SS" into a Date (null if unparseable). */
export function parseCreatedAt(createdAt: string): Date | null {
  const iso = createdAt.includes('Z') ? createdAt : `${createdAt.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Classify upload age for relative display. `now` injectable for tests. */
export function relativeTimeBucket(createdAt: string, now: Date = new Date()): RelativeBucket {
  const parsed = parseCreatedAt(createdAt);
  if (!parsed) return { kind: 'invalid', raw: createdAt };

  const diffMs = now.getTime() - parsed.getTime();
  if (diffMs < 0) {
    // Clock skew — treat as just uploaded
    return { kind: 'relative', unit: 'second', value: 0 };
  }
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return { kind: 'relative', unit: 'second', value: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { kind: 'relative', unit: 'minute', value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: 'relative', unit: 'hour', value: hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { kind: 'relative', unit: 'day', value: days };

  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return { kind: 'date', date: `${y}-${m}-${d}` };
}
