const pending = new Set<Promise<void>>();

/** Include scope cleanup as well as lease release when draining browser storage work. */
export function trackModraClosure(work: Promise<void>) {
  const settled = work.catch(() => undefined);
  pending.add(settled);
  void settled.finally(() => pending.delete(settled));
}

export async function drainModraClosures() {
  // Snapshot the set: an opening session must not wait on its own later cleanup.
  await Promise.all(pending);
}