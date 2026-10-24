type Call = { id: string; name: string; input: Record<string, unknown> };
function sse(events: unknown[], named = false) {
  return new Response(
    events
      .map(
        (event) => `${named ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function responsesFixture(call?: Call, text = "Ready for review.") {
  const events: unknown[] = [
    { type: "response.created", response: { id: "resp-local", model: "test-model", created_at: 1 } },
  ];
  if (call) {
    const item = { type: "function_call", id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: "" };
    const args = JSON.stringify(call.input);
    events.push({ type: "response.output_item.added", output_index: 0, item });
    for (const delta of [args.slice(0, 8), args.slice(8)])
      events.push({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta });
    events.push({ type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: args });
    events.push({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, arguments: args, status: "completed" },
    });
  } else {
    events.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg-text" } });
    events.push({ type: "response.output_text.delta", item_id: "msg-text", output_index: 0, delta: text });
    events.push({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg-text" } });
  }
  events.push({ type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 2 } } });
  return sse(events, true);
}

export function anthropicFixture(call?: Call, text = "Ready for review.") {
  const events: unknown[] = [
    {
      type: "message_start",
      message: { id: "msg-local", model: "test-model", role: "assistant", usage: { input_tokens: 4 } },
    },
  ];
  if (call) {
    events.push({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
    });
    const args = JSON.stringify(call.input);
    for (const partial_json of [args.slice(0, 8), args.slice(8)])
      events.push({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } });
  } else {
    events.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    events.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  }
  events.push(
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  );
  return sse(events, true);
}

export function geminiFixture(call?: Call, text = "Ready for review.") {
  return sse([
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: call
              ? [
                  {
                    functionCall: { id: call.id, name: call.name, args: call.input },
                    thoughtSignature: "opaque-signature",
                  },
                ]
              : [{ text }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
    },
  ]);
}