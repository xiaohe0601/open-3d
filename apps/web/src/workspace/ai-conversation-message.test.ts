import { expect, test } from "vite-plus/test";
import { MAX_CONVERSATION_IMAGE_BYTES, validateConversationImages } from "./ai-conversation-message";

test("validates image count, raster formats and per-image size before reading", () => {
  const file = { type: "image/png", size: 100 };
  expect(validateConversationImages([file, file], 3)).toBeNull();
  expect(validateConversationImages([file, file], 4)).toBe("imageCountError");
  expect(
    validateConversationImages(
      Array.from({ length: 5 }, () => file),
      0,
    ),
  ).toBeNull();
  expect(
    validateConversationImages(
      Array.from({ length: 6 }, () => file),
      0,
    ),
  ).toBe("imageCountError");
  for (const type of ["image/svg+xml", "text/html", "application/pdf", ""]) {
    expect(validateConversationImages([{ ...file, type }], 0)).toBe("imageTypeError");
  }
  expect(validateConversationImages([{ ...file, size: 0 }], 0)).toBe("imageSizeError");
  expect(validateConversationImages([{ ...file, size: MAX_CONVERSATION_IMAGE_BYTES }], 0)).toBeNull();
  expect(validateConversationImages([{ ...file, size: MAX_CONVERSATION_IMAGE_BYTES + 1 }], 0)).toBe("imageSizeError");
});