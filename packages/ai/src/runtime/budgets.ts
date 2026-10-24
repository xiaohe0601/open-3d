import type { SemanticMessage } from "../messages/history.ts";
import { ModraContextError } from "./context.ts";

// Application safety budgets in bytes, not claims about a provider's token window.
export const MODRA_BUDGETS = {
  historyBytes: 1024 * 1024,
  imageBytes: 30 * 1024 * 1024,
  responseBytes: 4 * 1024 * 1024,
  textBytes: 512 * 1024,
  toolBytes: 256 * 1024,
} as const;

export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function assertContextBudget(history: readonly SemanticMessage[]) {
  let images = 0;
  for (const message of history)
    for (const content of message.content) if (content.type === "image") images += content.asset.byteLength;
  if (images > MODRA_BUDGETS.imageBytes || jsonBytes(history) > MODRA_BUDGETS.historyBytes)
    throw new ModraContextError("context-limit");
}

/** Bound raw SSE before SDK parsing, including oversized tool arguments and error bodies. */
export function boundedProviderFetch(fetcher: typeof fetch): typeof fetch {
  return async (...args) => {
    const response = await fetcher(...args);
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) return controller.close();
          bytes += next.value.byteLength;
          if (bytes > MODRA_BUDGETS.responseBytes) {
            void reader.cancel().catch(() => {});
            controller.error(new ModraContextError("output-limit"));
          } else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}