// Orphan cleanup (design doc §3 step 4): when a ticket's expected file name changes -- most often
// `settings.tickets.key_prefix` itself changing -- the old file is never overwritten by rendering a
// new one, so it has to be found and deleted explicitly, or it accumulates on disk forever. Pure:
// the caller supplies what "expected" means and what is actually on disk.
export function findOrphans(
  expected: ReadonlySet<string>,
  present: readonly string[],
): readonly string[] {
  return present.filter((name) => !expected.has(name));
}
