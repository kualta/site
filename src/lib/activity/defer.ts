/** the platform's own `waitUntil`, or nothing when a page renders without one */
export function waitUntilFrom(
  context: { waitUntil(work: Promise<unknown>): void } | undefined,
): ((work: Promise<unknown>) => void) | undefined {
  if (!context) return undefined;
  return (work) => context.waitUntil(work);
}
