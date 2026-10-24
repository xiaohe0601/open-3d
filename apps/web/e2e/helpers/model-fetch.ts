import { responsesFixture, anthropicFixture, geminiFixture } from "../../../../tests/fixtures/ai/native-protocols";
import { vi } from "vite-plus/test";
import { chatTextResponse } from "../../../../tests/fixtures/ai/chat-completions";

export function isTitleRequest(init?: RequestInit) {
  if (typeof init?.body !== "string") return false;
  try {
    const body = JSON.parse(init.body);
    return !body.tools?.length && JSON.stringify(body).includes("Name this modeling conversation.");
  } catch {
    return false;
  }
}

/** Keep modeling round assertions separate from the independent metadata request. */
export function mockModelFetch() {
  const original = globalThis.fetch;
  const model = vi.fn<typeof fetch>((...args) => original(...args));
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (!isTitleRequest(init)) return model(input, init);
    const body = JSON.parse(init!.body as string);
    return Promise.resolve(
      body.contents
        ? geminiFixture(undefined, "Modeling")
        : body.input
          ? responsesFixture(undefined, "Modeling")
          : body.system
            ? anthropicFixture(undefined, "Modeling")
            : chatTextResponse("title", "Modeling"),
    );
  });
  return model;
}