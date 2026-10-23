import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import {
  deserializeModelingDocument,
  DocumentValidationError,
  serializeModelingDocument,
  validateModelingDocument,
} from "./document.ts";

const fixturePath = (name) => fileURLToPath(new URL(`../../../tests/fixtures/documents/${name}`, import.meta.url));
const readFixture = async (name) => JSON.parse(await readFile(fixturePath(name), "utf8"));

test("valid V1 fixture validates and serializes deterministically", async () => {
  const fixture = await readFixture("valid-v1.json");
  validateModelingDocument(fixture);

  const serialized = serializeModelingDocument(fixture);
  const reopened = deserializeModelingDocument(serialized);

  assert.deepEqual(reopened, fixture);
  assert.equal(serializeModelingDocument(reopened), serialized);
});

test("selection must reference stable component identities in its active mesh", async () => {
  const fixture = await readFixture("invalid-v1-unknown-component.json");

  assert.throws(
    () => validateModelingDocument(fixture),
    (error) =>
      error instanceof DocumentValidationError &&
      error.issues.some((issue) => issue.path === "$.selection.componentIds"),
  );
});

test("duplicate identities and unsupported schema versions are rejected", async () => {
  const fixture = await readFixture("valid-v1.json");
  fixture.objects[0].mesh.vertices[1].id = fixture.objects[0].mesh.vertices[0].id;
  assert.throws(() => validateModelingDocument(fixture), DocumentValidationError);

  const unsupported = await readFixture("valid-v1.json");
  unsupported.schemaVersion = 2;
  assert.throws(() => validateModelingDocument(unsupported), DocumentValidationError);
});

test("malformed JSON returns a structured validation error", () => {
  assert.throws(
    () => deserializeModelingDocument("{"),
    (error) => error instanceof DocumentValidationError && error.issues[0]?.path === "$",
  );
});