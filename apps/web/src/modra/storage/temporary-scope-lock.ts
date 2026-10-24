const lockName = (scopeId: string) => `open-3d:workspace:${scopeId}`;
const browserLocks = () => (typeof navigator === "undefined" ? undefined : navigator.locks);

/** Unlike a heartbeat lease, this lock survives a frozen background tab. */
export function holdTemporaryScope(scopeId: string) {
  const locks = browserLocks();
  if (!locks || !scopeId.startsWith("temporary:")) return { ready: Promise.resolve(false), close: () => {} };
  const abort = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let notify!: (acquired: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    notify = resolve;
  });
  void locks
    .request(lockName(scopeId), { signal: abort.signal }, async () => {
      notify(true);
      await held;
    })
    .catch(() => notify(false));
  return {
    ready,
    close: () => {
      release();
      abort.abort();
    },
  };
}

/** Without Web Locks, skip automatic recovery rather than risk another tab's work. */
export async function withInactiveTemporaryScope(scopeId: string, action: () => Promise<void>) {
  const locks = browserLocks();
  if (!locks) return;
  await locks.request(lockName(scopeId), { ifAvailable: true }, async (lock) => {
    if (lock) await action();
  });
}