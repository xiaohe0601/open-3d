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
import { getModelingOperationCatalog, ModelingContractError, validateCommandArguments } from "./commands.ts";
import { ModelingCommandProcessor } from "./processor.ts";

const fixturePath = fileURLToPath(new URL("../../../tests/fixtures/documents/valid-v1.json", import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function generatedDocument(seed, objectCount) {
  const random = seededRandom(seed);
  const document = structuredClone(fixture);
  document.id = `document-${seed}`;
  document.name = `Generated ${seed}`;
  document.workspace.projection = random() < 0.5 ? "perspective" : "orthographic";
  document.workspace.showGrid = random() < 0.5;
  document.workspace.orthographicScale = 1 + random() * 100;
  document.objects[0].transform.position = [random() * 20 - 10, random() * 20 - 10, random() * 20 - 10];

  for (let index = 1; index < objectCount; index += 1) {
    const id = `generated-object-${seed}-${index}`;
    document.objects.push({
      id,
      name: `Object ${index}`,
      transform: {
        position: [random() * 20 - 10, random() * 20 - 10, random() * 20 - 10],
        rotation: [0, 0, 0, 1],
        scale: [0.1 + random() * 4, 0.1 + random() * 4, 0.1 + random() * 4],
      },
      mesh: null,
      visible: random() >= 0.25,
      parentId: index === 1 ? null : `generated-object-${seed}-${index - 1}`,
    });
    document.scenes[0].objectIds.push(id);
  }
  return document;
}

function expectInvalid(document) {
  assert.throws(() => validateModelingDocument(document), DocumentValidationError);
}

test("generated valid documents preserve all stable identities through canonical round trips", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const document = generatedDocument(seed, 1 + (seed % 8));
    validateModelingDocument(document);

    const componentIds = document.objects[0].mesh.vertices
      .concat(document.objects[0].mesh.edges, document.objects[0].mesh.faces)
      .map(({ id }) => id);
    const serialized = serializeModelingDocument(document);
    const reopened = deserializeModelingDocument(serialized);

    assert.deepEqual(reopened, document, `round trip mismatch for seed ${seed}`);
    assert.deepEqual(
      reopened.objects[0].mesh.vertices
        .concat(reopened.objects[0].mesh.edges, reopened.objects[0].mesh.faces)
        .map(({ id }) => id),
      componentIds,
      `component identity changed for seed ${seed}`,
    );
    assert.equal(serializeModelingDocument(reopened), serialized);
  }
});

test("generated malformed documents reject dangling and duplicate identities", () => {
  for (let seed = 1; seed <= 24; seed += 1) {
    const mutations = [
      (doc) => {
        doc.scenes[0].objectIds.push(`missing-${seed}`);
      },
      (doc) => {
        doc.objects[0].parentId = `missing-${seed}`;
      },
      (doc) => {
        doc.objects[0].mesh.edges[0].vertexIds[0] = `missing-${seed}`;
      },
      (doc) => {
        doc.objects[0].mesh.faces[0].materialId = `missing-${seed}`;
      },
      (doc) => {
        doc.selection.componentIds[0] = `missing-${seed}`;
      },
      (doc) => {
        doc.objects[0].mesh.vertices[1].id = doc.objects[0].mesh.vertices[0].id;
      },
    ];
    const mutation = mutations[(seed - 1) % mutations.length];
    const document = generatedDocument(seed + 100, 1 + (seed % 5));
    mutation(document);
    expectInvalid(document);
  }
});

test("catalog command schemas consistently reject malformed generated boundary values", () => {
  const catalog = getModelingOperationCatalog();
  assert.ok(catalog.commands.length > 0);

  for (const segments of [-1, 0, 0.5, 33, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        validateCommandArguments("mesh.bevelEdges", {
          objectId: "object-1",
          edgeIds: ["edge-1"],
          width: 1,
          segments,
        }),
      (error) =>
        error instanceof ModelingContractError && error.code === "invalid-arguments" && error.details.issues.length > 0,
    );
  }
  for (const segments of [1, 2, 16, 32]) {
    assert.doesNotThrow(() =>
      validateCommandArguments("mesh.bevelEdges", {
        objectId: "object-1",
        edgeIds: ["edge-1"],
        width: Number.MIN_VALUE,
        segments,
      }),
    );
  }
});

test("generated rename histories restore exact snapshots across undo and redo", async () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const random = seededRandom(seed * 17);
    const document = generatedDocument(seed + 200, 1 + (seed % 4));
    const handler = (staged, args) => {
      const object = staged.objects.find(({ id }) => id === args.objectId);
      if (!object) throw new ModelingContractError("not-found", "Object not found.");
      object.name = args.name;
      return {
        document: staged,
        result: {
          affectedEntityIds: [object.id],
          selection: structuredClone(staged.selection),
        },
      };
    };
    const processor = new ModelingCommandProcessor(document, {
      handlers: { "object.rename": handler },
    });
    const before = processor.getDocumentSnapshot();
    const renameCount = 1 + Math.floor(random() * 8);
    for (let index = 0; index < renameCount; index += 1) {
      processor.executeCommand({
        commandId: "object.rename",
        arguments: { objectId: "object-1", name: `seed-${seed}-rename-${index}` },
      });
    }
    const committed = processor.getDocumentSnapshot();

    for (let index = 0; index < renameCount; index += 1) assert.equal(processor.undo(), true);
    assert.deepEqual(processor.getDocumentSnapshot(), before, `undo mismatch for seed ${seed}`);
    assert.equal(processor.undo(), false);
    for (let index = 0; index < renameCount; index += 1) assert.equal(processor.redo(), true);
    assert.deepEqual(processor.getDocumentSnapshot(), committed, `redo mismatch for seed ${seed}`);
  }
});