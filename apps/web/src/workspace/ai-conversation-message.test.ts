import { expect, test } from "vite-plus/test";
import {
  conversationHistory,
  MAX_CONVERSATION_IMAGE_BYTES,
  validateConversationImages,
  type ConversationImage,
} from "./ai-conversation-message";

const image: ConversationImage = {
  id: "reference",
  name: "reference.png",
  mediaType: "image/png",
  dataUrl: "data:image/png;base64,aW1hZ2U=",
};

test("preserves text-only history and omits empty assistant placeholders", () => {
  expect(
    conversationHistory([
      { id: 1, role: "user", text: "Create a chair" },
      { id: 2, role: "assistant", text: "Partial reply" },
      { id: 3, role: "assistant", text: " \n " },
    ]),
  ).toEqual([
    { role: "user", content: "Create a chair" },
    { role: "assistant", content: "Partial reply" },
  ]);
});

test("includes multiple images in user history, including image-only messages", () => {
  const second = { ...image, id: "second", name: "side.png" };
  expect(
    conversationHistory([
      { id: 1, role: "user", text: "Model these views", images: [image, second] },
      { id: 2, role: "user", text: "", images: [image] },
    ]),
  ).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "Model these views" },
        { type: "image", image: image.dataUrl, mediaType: "image/png" },
        { type: "image", image: second.dataUrl, mediaType: "image/png" },
      ],
    },
    { role: "user", content: [{ type: "image", image: image.dataUrl, mediaType: "image/png" }] },
  ]);
});

test("validates image count, raster formats and per-image size before reading", () => {
  const file = { type: "image/png", size: 100 };
  expect(validateConversationImages([file, file], 4)).toBeNull();
  expect(validateConversationImages([file, file], 5)).toBe("imageCountError");
  for (const type of ["image/svg+xml", "text/html", "application/pdf", ""]) {
    expect(validateConversationImages([{ ...file, type }], 0)).toBe("imageTypeError");
  }
  expect(validateConversationImages([{ ...file, size: 0 }], 0)).toBe("imageSizeError");
  expect(validateConversationImages([{ ...file, size: MAX_CONVERSATION_IMAGE_BYTES }], 0)).toBeNull();
  expect(validateConversationImages([{ ...file, size: MAX_CONVERSATION_IMAGE_BYTES + 1 }], 0)).toBe("imageSizeError");
});