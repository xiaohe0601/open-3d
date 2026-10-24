import { expect, test } from "vite-plus/test";
import { parseProjectRoute, projectPath } from "./project-routes";

test("distinguishes stored project IDs from reserved temporary IDs", () => {
  expect(parseProjectRoute("/projects/project-123")).toEqual({ kind: "saved", id: "project-123" });
  expect(parseProjectRoute("/projects/temp-123/")).toEqual({ kind: "temporary", id: "temp-123" });
  expect(projectPath(undefined, "temporary:123")).toBe("/projects/temp-123");
  expect(projectPath("saved-456", "temporary:123")).toBe("/projects/saved-456");
});

test.each([
  "/",
  "/projects/",
  "/other/id",
  "/projects/a/b",
  "/projects/%",
  "/projects/%2F",
  "/projects/..",
  "/projects/" + "a".repeat(201),
])("rejects malformed project route %s", (path) => {
  expect(parseProjectRoute(path)).toEqual({ kind: "invalid" });
});