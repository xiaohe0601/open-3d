import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { assertContextBudget, boundedProviderFetch, MODRA_BUDGETS } from "./budgets.ts";
import { classifyModraProviderError } from "./errors.ts";

test("image budget counts original bytes without truncating tool pairs or transcript", () => {
  const history = [
    { id: "one", role: "user", content: [{ type: "image", asset: { byteLength: MODRA_BUDGETS.imageBytes + 1 } }] },
  ];
  const before = structuredClone(history);
  assert.throws(() => assertContextBudget(history), { code: "context-limit" });
  assert.deepEqual(history, before);
});
test.each(["context_length_exceeded", "prompt is too long", "too many tokens"])(
  "maps provider context failure: %s",
  (message) => {
    assert.equal(classifyModraProviderError({ statusCode: 400, message }), "context-limit");
  },
);
test("bounds incremental SSE before SDK parsing, cancels upstream and classifies wrapped error", async () => {
  let cancelled = false;
  const fetcher = boundedProviderFetch(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const response = await fetcher("https://models.example/stream");
  await assert.rejects(response.arrayBuffer(), (error) => {
    assert.equal(classifyModraProviderError({ cause: error }), "output-limit");
    return true;
  });
  assert.equal(cancelled, true);
});