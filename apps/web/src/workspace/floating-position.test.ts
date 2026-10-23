import { expect, test } from "vite-plus/test";
import { clampFloatingPosition } from "./floating-position";

test("keeps floating controls inside the viewport with a safe margin", () => {
  const viewport = { width: 390, height: 844 };
  const size = { width: 56, height: 56 };
  expect(clampFloatingPosition({ x: 150, y: 300 }, viewport, size)).toEqual({ x: 150, y: 300 });
  expect(clampFloatingPosition({ x: -50, y: -100 }, viewport, size)).toEqual({ x: 16, y: 16 });
  expect(clampFloatingPosition({ x: 1500, y: 3000 }, viewport, size)).toEqual({ x: 318, y: 772 });
});

test("recovers a reachable control when the viewport shrinks below its margins or size", () => {
  expect(clampFloatingPosition({ x: 1500, y: 1000 }, { width: 70, height: 50 }, { width: 56, height: 56 })).toEqual({
    x: 14,
    y: 0,
  });
});