import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createLocalProjectStore, LocalProjectStorageError } from "./index.ts";

test("reports a recoverable storage error when IndexedDB is unavailable", async () => {
  const store = createLocalProjectStore(undefined);

  await assert.rejects(
    store.list(),
    (error) => error instanceof LocalProjectStorageError && error.code === "unavailable",
  );
  for (const operation of [
    () => store.rename("missing", "Desk"),
    () => store.duplicate("missing", "Desk copy"),
    () => store.remove("missing"),
  ]) {
    await assert.rejects(
      operation(),
      (error) => error instanceof LocalProjectStorageError && error.code === "unavailable",
    );
  }
});