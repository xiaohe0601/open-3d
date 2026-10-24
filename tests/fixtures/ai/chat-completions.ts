export function chatToolCallResponse(id: string, name: string, args: Record<string, unknown>) {
  return new Response(
    [
      `data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${id}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function chatTextResponse(id: string, text: string) {
  return new Response(
    [
      `data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function controlledChatResponse(id = "controlled") {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel() {
        closed = true;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const enqueue = (value: string) => {
    if (!closed) controller.enqueue(new TextEncoder().encode(value));
  };
  return {
    response,
    text(text: string) {
      enqueue(
        `data: ${JSON.stringify({
          id: `chatcmpl-${id}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`,
      );
    },
    finish() {
      if (closed) return;
      enqueue(
        `data: ${JSON.stringify({
          id: `chatcmpl-${id}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
      controller.close();
      closed = true;
    },
    fail(error: unknown = new TypeError("Failed to fetch")) {
      if (closed) return;
      controller.error(error);
      closed = true;
    },
  };
}