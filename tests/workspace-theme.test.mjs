import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const theme = readFileSync(new URL("../apps/web/src/theme.css", import.meta.url), "utf8");
const style = readFileSync(new URL("../apps/web/src/style.css", import.meta.url), "utf8");

function tokens(selector) {
  const body = theme.slice(theme.indexOf(selector)).split("}")[0];
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/g)].map((match) => [match[1], match[2]]));
}

function luminance(hex) {
  return [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(first, second) {
  const [a, b] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

describe("semantic workspace themes", () => {
  test.each([":root {", ":root.dark {"])("provides readable surfaces and matching feedback in %s", (selector) => {
    const values = tokens(selector);
    for (const surface of ["ground", "sheet", "raised", "soft", "selection", "viewport"]) {
      for (const ink of ["foreground", "muted", "faint"]) {
        expect(contrast(values[ink], values[surface]), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const [ink, surface] of [
      ["primary-foreground", "primary"],
      ["primary-foreground", "primary-hover"],
      ["accent-foreground", "accent"],
      ["positive", "positive-soft"],
      ["warning", "warning-soft"],
      ["destructive", "negative-soft"],
    ]) {
      expect(contrast(values[ink], values[surface]), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(values.ring, values.sheet)).toBeGreaterThanOrEqual(3);
    expect(contrast(values.input, values.sheet)).toBeGreaterThanOrEqual(3);
  });

  test("both themes define the same roles and use the root dark class", () => {
    expect(Object.keys(tokens(":root.dark {"))).toEqual(Object.keys(tokens(":root {")));
    expect(style).toContain("@custom-variant dark (&:is(.dark *))");
    expect(style).toContain('--font-sans: "IBM Plex Sans"');
    expect(style).toContain('@import "./theme.css"');
  });

  test.each([":root {", ":root.dark {"])(
    "keeps workspace chrome achromatic with distinct interaction levels in %s",
    (selector) => {
      const values = tokens(selector);
      for (const role of [
        "ground",
        "sheet",
        "raised",
        "soft",
        "selection",
        "border",
        "rule",
        "input",
        "foreground",
        "muted",
        "faint",
        "accent",
        "accent-soft",
        "accent-foreground",
        "primary",
        "primary-hover",
        "primary-foreground",
        "ring",
        "viewport",
        "thumbnail",
        "thumbnail-line",
      ]) {
        const channels = values[role].slice(1).match(/../g);
        expect(new Set(channels).size, `${role} is neutral`).toBe(1);
      }
      expect(contrast(values.primary, values.sheet)).toBeGreaterThanOrEqual(12);
      expect(contrast(values.primary, values["primary-hover"])).toBeGreaterThanOrEqual(1.2);
      expect(contrast(values.selection, values.sheet)).toBeGreaterThanOrEqual(1.2);
      expect(contrast(values["thumbnail-line"], values.thumbnail)).toBeGreaterThanOrEqual(3);
    },
  );

  test("inverts surface and emphasis luminance between light and dark", () => {
    const light = tokens(":root {");
    const dark = tokens(":root.dark {");
    for (const role of ["ground", "sheet", "viewport"]) {
      expect(luminance(light[role])).toBeGreaterThan(0.9);
      expect(luminance(dark[role])).toBeLessThan(0.02);
    }
    expect(luminance(light.primary)).toBeLessThan(0.02);
    expect(luminance(dark.primary)).toBeGreaterThan(0.9);
    expect(luminance(light.foreground)).toBeLessThan(luminance(light.muted));
    expect(luminance(dark.foreground)).toBeGreaterThan(luminance(dark.muted));
  });
});