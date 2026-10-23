import { expect, test } from "vite-plus/test";
import { selectAIChatPlacement, type AIChatPlacement } from "./ai-chat-placement";

const viewport = { width: 1440, height: 1000 };
const anchor = { x: 140, y: 470, width: 56, height: 56 };

test("selects usable space on first open and never chooses an unreadable horizontal column", () => {
  expect(selectAIChatPlacement({ ...anchor, x: 1360, y: 920 }, viewport, null)).toBe("top-end");
  expect(selectAIChatPlacement({ ...anchor, x: 16, y: 16 }, viewport, null)).toBe("bottom-end");
  expect(selectAIChatPlacement({ ...anchor, x: 150, y: 220 }, { width: 390, height: 500 }, null)).toBe("bottom-end");
});

test("keeps the current direction when every candidate fits equally well", () => {
  expect(selectAIChatPlacement({ ...anchor, x: 16, y: 16 }, viewport, "right-end")).toBe("right-end");
});

test("uses separate horizontal entry and exit thresholds near a side-fit boundary", () => {
  let placement: AIChatPlacement = "bottom-end";
  for (const x of [447, 449, 450, 447, 455, 460, 478]) {
    placement = selectAIChatPlacement({ ...anchor, x }, { width: 900, height: 1000 }, placement);
    expect(placement).toBe("bottom-end");
  }
  placement = selectAIChatPlacement({ ...anchor, x: 481 }, { width: 900, height: 1000 }, placement);
  expect(placement).toBe("left-end");
  for (const x of [479, 450, 448, 449, 448]) {
    placement = selectAIChatPlacement({ ...anchor, x }, { width: 900, height: 1000 }, placement);
    expect(placement).toBe("left-end");
  }
  expect(selectAIChatPlacement({ ...anchor, x: 447 }, { width: 900, height: 1000 }, placement)).toBe("bottom-end");
});

test("does not oscillate around the top/bottom boundary but changes after a meaningful improvement", () => {
  const narrow = { width: 390, height: 1000 };
  let placement: AIChatPlacement = "top-end";
  for (const y of [470, 474, 468, 476, 470]) {
    placement = selectAIChatPlacement(anchorWithY(y), narrow, placement);
    expect(placement).toBe("top-end");
  }
  placement = selectAIChatPlacement(anchorWithY(440), narrow, placement);
  expect(placement).toBe("bottom-end");
  for (const y of [468, 476, 470, 480]) {
    placement = selectAIChatPlacement(anchorWithY(y), narrow, placement);
    expect(placement).toBe("bottom-end");
  }
  expect(selectAIChatPlacement(anchorWithY(510), narrow, placement)).toBe("top-end");
});

test("abandons a side that no longer fits after resize and gives deterministic results", () => {
  const narrow = { width: 390, height: 500 };
  const next = selectAIChatPlacement({ ...anchor, x: 150, y: 220 }, narrow, "left-end");
  expect(["top-end", "bottom-end"]).toContain(next);
  expect(selectAIChatPlacement({ ...anchor, x: 150, y: 220 }, narrow, next)).toBe(next);
});

function anchorWithY(y: number) {
  return { ...anchor, y };
}