import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js";
import { GLTFExporter } from "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/loaders/GLTFLoader.js";
import { createBenchmarkFixtures } from "../../fixtures/benchmarks/scenes.mjs";

const fixtures = createBenchmarkFixtures();
const root = document.querySelector("#viewport");
const state = document.querySelector("#state");
const metrics = document.querySelector("#metrics");
const log = document.querySelector("#log");
window.addEventListener("error", (event) => {
  state.textContent = `Error: ${event.message}`;
});
window.addEventListener("unhandledrejection", (event) => {
  state.textContent = `Error: ${event.reason?.message ?? event.reason}`;
});
const scene = new THREE.Scene();
scene.background = new THREE.Color("#121a1a");
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
camera.position.set(8, 7, 11);
camera.lookAt(0, 0, 0);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
root.append(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xddebe4, 0x35463d, 2.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
keyLight.position.set(4, 8, 6);
scene.add(keyLight);
const grid = new THREE.GridHelper(20, 20, 0x668c78, 0x34413c);
scene.add(grid);

let activeObjects = [];
let activeFixture = "primitive";
let dragging = false;
let lastPointer = null;
let pendingPointerAt = null;
let lastFrameAt = performance.now();
const frameIntervals = [];
const pointerSamples = [];
const commandSamples = [];
const roundTripSamples = [];
let lastMetricsAt = 0;
let frameRunStartedAt = null;

const material = new THREE.MeshStandardMaterial({ color: "#89b89b", roughness: 0.67 });

function clearFixture() {
  for (const object of activeObjects) {
    scene.remove(object);
    object.geometry.dispose();
  }
  activeObjects = [];
}

function fixtureGeometry(data) {
  const positions = new Float32Array(data.vertices.length * 3);
  data.vertices.forEach((vertex, index) => positions.set(vertex, index * 3));
  const indices = [];
  for (const face of data.faces) {
    for (let index = 1; index < face.length - 1; index += 1) {
      indices.push(face[0], face[index], face[index + 1]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function loadFixture(name) {
  clearFixture();
  activeFixture = name;
  if (name === "primitive") {
    activeObjects = fixtures.primitiveScene.objects.map((item) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), material);
      mesh.position.set(item.position[0], 0.35, item.position[1]);
      mesh.userData.fixtureId = item.id;
      scene.add(mesh);
      return mesh;
    });
    camera.position.set(14, 12, 17);
  } else {
    const data = name === "editable" ? fixtures.editableQuad : fixtures.denseMesh;
    const mesh = new THREE.Mesh(fixtureGeometry(data), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(-data.vertices.reduce((max, vertex) => Math.max(max, vertex[0]), 0) / 2, 0, 0);
    if (name === "dense") {
      mesh.position.x = -64;
      mesh.position.z = 64;
      camera.position.set(100, 90, 120);
    } else {
      mesh.position.x = -8;
      mesh.position.z = 8;
      camera.position.set(15, 13, 17);
    }
    mesh.userData.fixtureId = name;
    scene.add(mesh);
    activeObjects = [mesh];
  }
  camera.lookAt(0, 0, 0);
}

function applyResize() {
  const width = root.clientWidth;
  const height = root.clientHeight;
  if (!width || !height) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

let resizeFrame = 0;
function scheduleResize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(applyResize);
}

function percentile(values, percent) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(percent * sorted.length) - 1)];
}

function summarize(values) {
  if (!values.length) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return values.length
    ? {
        count: values.length,
        medianMs: Number(percentile(values, 0.5).toFixed(3)),
        p95Ms: Number(percentile(values, 0.95).toFixed(3)),
        varianceMs2: Number(variance.toFixed(4)),
      }
    : null;
}

function renderFrame() {
  const now = performance.now();
  const interval = now - lastFrameAt;
  if (interval > 0 && interval < 1000) frameIntervals.push(interval);
  if (frameIntervals.length > 3600) frameIntervals.shift();
  lastFrameAt = now;
  renderer.render(scene, camera);
  if (pendingPointerAt !== null) {
    pointerSamples.push(now - pendingPointerAt);
    if (pointerSamples.length > 2000) pointerSamples.shift();
    pendingPointerAt = null;
  }
  if (now - lastMetricsAt >= 250) {
    const fpsValues = frameIntervals.map((value) => 1000 / value);
    const heap = performance.memory?.usedJSHeapSize;
    metrics.textContent = JSON.stringify(
      {
        fixture: activeFixture,
        three: THREE.REVISION,
        objects: activeObjects.length,
        triangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.calls,
        geometryCount: renderer.info.memory.geometries,
        textureCount: renderer.info.memory.textures,
        fpsMedian: fpsValues.length ? Number(percentile(fpsValues, 0.5).toFixed(1)) : null,
        frameMsP95: summarize(frameIntervals)?.p95Ms ?? null,
        frameRunSeconds: frameRunStartedAt === null ? null : Number(((now - frameRunStartedAt) / 1000).toFixed(1)),
        pointerToRenderMs: summarize(pointerSamples),
        jsHeapUsedMiB: heap ? Number((heap / 1048576).toFixed(1)) : "unavailable",
        devicePixelRatio,
        viewport: `${root.clientWidth}x${root.clientHeight}`,
      },
      null,
      2,
    );
    lastMetricsAt = now;
  }
  requestAnimationFrame(renderFrame);
}

function addLog(entry) {
  const oldEntries = log.textContent === "No benchmark run yet." ? [] : JSON.parse(log.textContent);
  oldEntries.push(entry);
  log.textContent = JSON.stringify(oldEntries, null, 2);
}

function measureCommand() {
  const batchDurations = [];
  const operationsPerBatch = 1000;
  for (let batch = 0; batch < 35; batch += 1) {
    const started = performance.now();
    for (let run = 0; run < operationsPerBatch; run += 1) {
      if (activeFixture === "primitive") {
        for (let index = 0; index < activeObjects.length; index += 1) {
          activeObjects[index].position.x += 0.000001;
          activeObjects[index].updateMatrix();
        }
      } else {
        const positions = activeObjects[0].geometry.attributes.position;
        for (let index = 0; index < positions.count; index += 1) {
          positions.setX(index, positions.getX(index) + 0.000001);
        }
        positions.needsUpdate = true;
      }
    }
    batchDurations.push(performance.now() - started);
  }
  const measured = batchDurations.slice(5);
  const perOperation = measured.map((duration) => duration / operationsPerBatch);
  commandSamples.push(...perOperation);
  const result = summarize(measured);
  const target =
    activeFixture === "primitive"
      ? `${activeObjects.length}-objects`
      : `${activeObjects[0].geometry.attributes.position.count}-vertices`;
  addLog({
    type: "command-transform",
    fixture: activeFixture,
    target,
    warmupBatches: 5,
    measuredBatches: measured.length,
    operationsPerBatch,
    batchDuration: result,
    perOperationMeanMs: Number(
      (measured.reduce((sum, value) => sum + value, 0) / measured.length / operationsPerBatch).toFixed(5),
    ),
  });
}

function runViewportSample() {
  frameIntervals.length = 0;
  frameRunStartedAt = performance.now();
  document.querySelector("#frame-run").disabled = true;
  document.querySelector("#frame-stop").disabled = false;
  const stopAt = frameRunStartedAt + 60_000;
  const finish = () => {
    if (performance.now() < stopAt) {
      requestAnimationFrame(finish);
      return;
    }
    stopViewportSample();
  };
  requestAnimationFrame(finish);
}

function stopViewportSample() {
  if (frameRunStartedAt === null) return;
  const elapsedMs = performance.now() - frameRunStartedAt;
  addLog({
    type: "viewport-frame-interval",
    fixture: activeFixture,
    durationSeconds: Number((elapsedMs / 1000).toFixed(1)),
    ...summarize(frameIntervals),
  });
  frameRunStartedAt = null;
  document.querySelector("#frame-run").disabled = false;
  document.querySelector("#frame-stop").disabled = true;
}

async function measureGlbRoundTrip() {
  const exporter = new GLTFExporter();
  const loader = new GLTFLoader();
  const runs = [];
  for (let run = 0; run < 35; run += 1) {
    const exportStart = performance.now();
    const glb = await new Promise((resolve, reject) => {
      exporter.parse(scene, resolve, reject, { binary: true });
    });
    const exportMs = performance.now() - exportStart;
    const importStart = performance.now();
    const parsed = await new Promise((resolve, reject) => {
      loader.parse(glb, "", resolve, reject);
    });
    const importMs = performance.now() - importStart;
    parsed.scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        for (const item of Array.isArray(object.material) ? object.material : [object.material]) {
          item.dispose();
        }
      }
    });
    runs.push({ exportMs, importMs, bytes: glb.byteLength });
  }
  const measured = runs.slice(5);
  const exportStats = summarize(measured.map((run) => run.exportMs));
  const importStats = summarize(measured.map((run) => run.importMs));
  const result = {
    type: "glb-round-trip",
    fixture: activeFixture,
    warmupRuns: 5,
    measuredRuns: measured.length,
    export: exportStats,
    import: importStats,
    bytes: measured.at(-1).bytes,
  };
  roundTripSamples.push(result);
  addLog(result);
}

function exportReport() {
  const report = {
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    webgl: renderer.getContext().getParameter(renderer.getContext().VERSION),
    fixture: activeFixture,
    measurements: {
      pointerToRender: summarize(pointerSamples),
      commandTransform: summarize(commandSamples),
      glbRoundTrips: roundTripSamples,
      frameIntervals: summarize(frameIntervals),
      jsHeapUsedMiB: performance.memory?.usedJSHeapSize
        ? Number((performance.memory.usedJSHeapSize / 1048576).toFixed(1))
        : null,
      threeRendererInfo: {
        ...renderer.info.render,
        memory: { ...renderer.info.memory },
      },
    },
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "foundation-benchmark-report.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

renderer.domElement.addEventListener("pointerdown", (event) => {
  dragging = true;
  lastPointer = [event.clientX, event.clientY];
  pendingPointerAt = performance.now();
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener("pointermove", (event) => {
  if (!dragging || !lastPointer) return;
  const dx = event.clientX - lastPointer[0];
  const dy = event.clientY - lastPointer[1];
  lastPointer = [event.clientX, event.clientY];
  const offset = camera.position.clone().sub(new THREE.Vector3(0, 0, 0));
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta -= dx * 0.006;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi + dy * 0.006, 0.08, Math.PI - 0.08);
  camera.position.setFromSpherical(spherical);
  camera.lookAt(0, 0, 0);
  pendingPointerAt = performance.now();
});
renderer.domElement.addEventListener("pointerup", () => {
  dragging = false;
  lastPointer = null;
});
renderer.domElement.addEventListener("pointercancel", () => {
  dragging = false;
  lastPointer = null;
});

document.querySelectorAll("[data-scene]").forEach((button) => {
  button.addEventListener("click", () => loadFixture(button.dataset.scene));
});
document.querySelector("#command").addEventListener("click", measureCommand);
document.querySelector("#roundtrip").addEventListener("click", measureGlbRoundTrip);
document.querySelector("#frame-run").addEventListener("click", runViewportSample);
document.querySelector("#frame-stop").addEventListener("click", stopViewportSample);
document.querySelector("#download").addEventListener("click", exportReport);
new ResizeObserver(scheduleResize).observe(root);
scheduleResize();
loadFixture("primitive");
state.textContent = "Running";
requestAnimationFrame(renderFrame);