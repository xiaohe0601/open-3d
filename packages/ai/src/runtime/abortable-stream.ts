/** Stop awaiting a non-cooperative iterator without letting a late rejection escape. */
export async function* abortableStream<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let complete = false;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve()
          .then(() => iterator.next())
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
      if (signal.aborted) throw signal.reason;
      if (next.done) {
        complete = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!complete)
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => {});
  }
}