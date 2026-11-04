/**
 * Ids a founder's typing has to survive.
 *
 * A company id becomes a directory name (the event log lives under `<state>/<orgId>/`) and a
 * segment of every event's `companyId`, so it must be stable, portable and non-empty on any
 * platform — a Chinese or emoji company name yields no ASCII at all, which is why the caller
 * falls back to `fallback` instead of producing an empty id.
 */
export function slugifyId(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug === '' ? fallback : slug;
}

/** `acme` → `acme-2` → `acme-3`: a taken id loses the race without overwriting the company that holds it. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${String(Date.now())}`;
}
