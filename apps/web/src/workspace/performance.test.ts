import { ModelingCommandProcessor, createCoreCommandHandlers } from "@open-3d/model-core";
import { buildDocumentProjection } from "@open-3d/viewport-three";
import { test } from "vite-plus/test";
import { benchmarkDefinitions } from "../../../../tests/fixtures/benchmarks/scenes.mjs";
import { createWorkspaceDocument } from "../../../../tests/fixtures/benchmarks/workspace-scenes.mjs";

const WARMUP_RUNS = 5;
const MEASURED_RUNS = 30;
const profileEnabled = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  ?.OPEN3D_RUN_PROFILE;

function percentile(values: number[], percentage: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(percentage * sorted.length) - 1)];
}

function measureProjection(document: ReturnType<typeof createWorkspaceDocument>) {
  const durations: number[] = [];
  for (let run = 0; run < WARMUP_RUNS + MEASURED_RUNS; run += 1) {
    const startedAt = performance.now();
    const projection = buildDocumentProjection(document);
    const durationMs = performance.now() - startedAt;
    projection.dispose();
    if (run >= WARMUP_RUNS) durations.push(durationMs);
  }
  return {
    runCount: durations.length,
    medianMs: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
  };
}

test.skipIf(profileEnabled !== "1")(
  "profiles representative workspace projections and full-document transform commands",
  () => {
    const primitiveDefinition = benchmarkDefinitions.primitiveScene;
    const primitiveDocument = createWorkspaceDocument(primitiveDefinition.objectCount, 0);
    const editableDocument = createWorkspaceDocument(1, benchmarkDefinitions.editableQuad.width);
    const denseDocument = createWorkspaceDocument(1, benchmarkDefinitions.denseMesh.width);

    const projection = {
      primitiveScene100Objects: measureProjection(primitiveDocument),
      editableQuad16x16: measureProjection(editableDocument),
      denseQuad128x128: measureProjection(denseDocument),
    };

    const object = primitiveDocument.objects[0];
    const commandDurations: number[] = [];
    for (let run = 0; run < WARMUP_RUNS + MEASURED_RUNS; run += 1) {
      const processor = new ModelingCommandProcessor(primitiveDocument, {
        handlers: createCoreCommandHandlers(),
      });
      const startedAt = performance.now();
      processor.executeCommand({
        commandId: "object.setTransform",
        arguments: {
          objectId: object.id,
          transform: {
            ...object.transform,
            position: [object.transform.position[0] + 0.001, ...object.transform.position.slice(1)],
          },
        },
      });
      const durationMs = performance.now() - startedAt;
      if (run >= WARMUP_RUNS) commandDurations.push(durationMs);
    }
    const results = {
      environment: {
        runtime: globalThis.navigator?.userAgent ?? "Node.js",
        platform: globalThis.navigator?.platform ?? "non-browser",
        architecture: globalThis.navigator?.hardwareConcurrency ?? null,
        warmupRuns: WARMUP_RUNS,
        measuredRuns: MEASURED_RUNS,
      },
      projection,
      command: {
        operation: "object.setTransform",
        document: "100 boxes with 800 vertices and 600 faces",
        runCount: commandDurations.length,
        medianMs: Number(percentile(commandDurations, 0.5).toFixed(3)),
        p95Ms: Number(percentile(commandDurations, 0.95).toFixed(3)),
      },
    };

    console.log(`WORKSPACE_PERFORMANCE ${JSON.stringify(results)}`);
    const denseFaceIds: string[] = [];
    let denseTriangleIndexCount = 0;
    const denseProjection = buildDocumentProjection(denseDocument);
    denseProjection.scene.traverse((node) => {
      const faceIds = node.userData.faceIdsByTriangle as string[] | undefined;
      if (!faceIds) return;
      denseFaceIds.push(...faceIds);
      const meshNode = node as typeof node & {
        isMesh?: boolean;
        geometry?: { index?: { count: number } | null };
      };
      if (meshNode.isMesh) {
        denseTriangleIndexCount = meshNode.geometry?.index?.count ?? 0;
      }
    });
    denseProjection.dispose();
    if (denseFaceIds.length !== benchmarkDefinitions.denseMesh.width ** 2 * 2) {
      throw new Error(`Expected two projected triangles per dense quad, received ${denseFaceIds.length}.`);
    }
    if (denseTriangleIndexCount !== benchmarkDefinitions.denseMesh.width ** 2 * 6) {
      throw new Error(`Unexpected dense mesh index count: ${denseTriangleIndexCount}.`);
    }
  },
);