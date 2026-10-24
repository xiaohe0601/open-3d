import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { LocalProjectStorageError, type LocalProjectStore } from "@open-3d/projects";
import type { ModelingDocument } from "@open-3d/model-core";
import { WorkspaceApp } from "../src/app";
import { createProcessor, emptyDocument } from "../src/workspace/modeling";
import { initializeI18n } from "../src/i18n";
import { IndexedDBModraRepository } from "../src/modra/storage/indexeddb-repository";
import { drainModraClosures } from "../src/modra/storage/lifecycle";
import { useWorkspaceUiStore } from "../src/workspace-ui-store";
import { addPrimitive, click } from "./helpers/workspace";

vi.mock("../src/workspace/ai-provider-sponsors-data", () => ({ loadAIProviderSponsors: async () => [] }));

let root: Root;
let container: HTMLDivElement;
let repository: IndexedDBModraRepository;
let store: LocalProjectStore;
let documents: Map<string, ModelingDocument>;
let initialURL: string;
let database: string;

beforeEach(async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  await initializeI18n("en");
  useWorkspaceUiStore.getState().setNotice("");
  await page.viewport(1440, 900);
  initialURL = window.location.href;
  window.history.replaceState(null, "", "/");
  database = `route-test-${crypto.randomUUID()}`;
  repository = new IndexedDBModraRepository({ name: database });
  documents = new Map();
  store = {
    list: async () =>
      [...documents].map(([id, document]) => ({ id, name: document.name, updatedAt: new Date().toISOString() })),
    load: vi.fn(async (id: string) => {
      const document = documents.get(id);
      if (!document) throw new LocalProjectStorageError("not-found", "Missing");
      return structuredClone(document);
    }),
    save: vi.fn(async (document: ModelingDocument, id = crypto.randomUUID()) => {
      documents.set(id, structuredClone(document));
      return { id, name: document.name, updatedAt: new Date().toISOString() };
    }),
    rename: vi.fn(),
    duplicate: vi.fn(),
    remove: vi.fn(async (id: string) => {
      documents.delete(id);
    }),
  };
  container = document.createElement("div");
  container.style.height = "100%";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await drainModraClosures();
  await repository.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(database);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Route test leaked a database connection"));
  });
  container.remove();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", initialURL);
});

async function mount() {
  await act(async () => root.render(<WorkspaceApp projectRouting projectStore={store} modraRepository={repository} />));
  await expect.element(page.getByRole("application", { name: "Interactive 3D scene" })).toBeInTheDocument();
}
function savedScene(name: string) {
  const processor = createProcessor({ ...emptyDocument(), name });
  processor.executeCommand({
    commandId: "scene.createPrimitive",
    arguments: { primitive: "box", name: `${name} box` },
  });
  return processor.getDocumentSnapshot();
}
async function navigate(id: string) {
  await act(async () => {
    window.history.pushState(null, "", `/projects/${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

test("fresh and refreshed temporary projects get distinct URLs without creating stored projects", async () => {
  await mount();
  const first = window.location.pathname;
  expect(first).toMatch(/^\/projects\/temp-/);
  expect(await store.list()).toEqual([]);
  await act(async () => root.unmount());
  await drainModraClosures();
  root = createRoot(container);
  await mount();
  expect(window.location.pathname).not.toBe(first);
  expect(window.location.pathname).toMatch(/^\/projects\/temp-/);
  expect(vi.mocked(store).load.mock.calls).toHaveLength(0);
});

test("first save replaces the temporary URL, retains Modra scope and later saves reuse the formal ID", async () => {
  await mount();
  const scope = `temporary:${window.location.pathname.split("temp-")[1]}`;
  const session = await repository.create(scope, "Before first save");
  await addPrimitive();
  await click(page.getByRole("button", { name: "Save", exact: true }));
  await expect.poll(() => documents.size).toBe(1);
  const id = [...documents.keys()][0]!;
  await expect.poll(() => window.location.pathname).toBe(`/projects/${id}`);
  expect(id).not.toMatch(/^temp-/);
  expect(await repository.scopeForProject(id)).toBe(scope);
  expect((await repository.load(session.id))?.title).toBe("Before first save");
  await addPrimitive();
  await click(page.getByRole("button", { name: "Save", exact: true }));
  await expect.poll(() => documents.get(id)?.objects.length).toBe(2);
  expect(documents.size).toBe(1);
});

test("saved deep links load the local project and retain its ID on subsequent save", async () => {
  documents.set("saved-one", savedScene("Linked project"));
  window.history.replaceState(null, "", "/projects/saved-one");
  await mount();
  await expect.element(page.getByRole("button", { name: "Linked project box", exact: true })).toBeInTheDocument();
  expect(window.location.pathname).toBe("/projects/saved-one");
  await addPrimitive();
  await click(page.getByRole("button", { name: "Save", exact: true }));
  await expect.poll(() => documents.get("saved-one")?.objects.length).toBe(2);
  expect(documents.size).toBe(1);
});

test("missing deep links show an error and normalize to a fresh temporary route without saving", async () => {
  window.history.replaceState(null, "", "/projects/missing");
  await mount();
  await expect.poll(() => window.location.pathname).toMatch(/^\/projects\/temp-/);
  await expect
    .element(page.getByText("Could not open this project. It may have been removed.").first())
    .toBeInTheDocument();
  expect(vi.mocked(store).save.mock.calls).toHaveLength(0);
});

test("navigation asks about unsaved work, cancel preserves scene/URL and discard opens the target", async () => {
  documents.set("target", savedScene("Target"));
  await mount();
  await addPrimitive();
  const path = window.location.pathname;
  await navigate("target");
  await expect.element(page.getByRole("dialog", { name: "Unsaved changes", exact: true })).toBeInTheDocument();
  expect(window.location.pathname).toBe(path);
  await click(page.getByRole("button", { name: "Cancel", exact: true }));
  expect(window.location.pathname).toBe(path);
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeInTheDocument();
  await navigate("target");
  await click(page.getByRole("button", { name: "Discard", exact: true }));
  await expect.poll(() => window.location.pathname).toBe("/projects/target");
  await expect.element(page.getByRole("button", { name: "Target box", exact: true })).toBeInTheDocument();
});

test("a late project load cannot replace a newer navigation", async () => {
  documents.set("newer", savedScene("Newer"));
  let resolve!: (document: ModelingDocument) => void;
  const load = store.load.bind(store);
  store.load = vi.fn((id: string) =>
    id === "slow"
      ? new Promise<ModelingDocument>((done) => {
          resolve = done;
        })
      : load(id),
  );
  await mount();
  await navigate("slow");
  await navigate("newer");
  await expect.poll(() => window.location.pathname).toBe("/projects/newer");
  await act(async () => resolve(savedScene("Stale")));
  expect(window.location.pathname).toBe("/projects/newer");
  await expect.element(page.getByRole("button", { name: "Newer box", exact: true })).toBeInTheDocument();
});

test("returning to the currently displayed URL cancels an outstanding route load", async () => {
  documents.set("current", savedScene("Current"));
  window.history.replaceState(null, "", "/projects/current");
  await mount();
  await expect.element(page.getByRole("button", { name: "Current box", exact: true })).toBeInTheDocument();
  let resolve!: (document: ModelingDocument) => void;
  store.load = vi.fn(
    () =>
      new Promise<ModelingDocument>((done) => {
        resolve = done;
      }),
  );
  await navigate("slow");
  await navigate("current");
  await act(async () => resolve(savedScene("Stale")));
  expect(window.location.pathname).toBe("/projects/current");
  await expect.element(page.getByRole("button", { name: "Current box", exact: true })).toBeInTheDocument();
});

test("save-and-continue stores the old workspace before loading a navigation target", async () => {
  documents.set("target", savedScene("Target"));
  await mount();
  await addPrimitive();
  await navigate("target");
  await click(page.getByRole("button", { name: "Save and continue", exact: true }));
  await expect.poll(() => window.location.pathname).toBe("/projects/target");
  expect(documents.size).toBe(2);
  expect([...documents].find(([id]) => id !== "target")?.[1].objects[0]?.name).toBe("Box");
  await expect.element(page.getByRole("button", { name: "Target box", exact: true })).toBeInTheDocument();
});

test("deleting an open archive detaches its URL without deleting the scene, and saving creates a new ID", async () => {
  documents.set("deleted", savedScene("Retained"));
  window.history.replaceState(null, "", "/projects/deleted");
  await mount();
  await expect.element(page.getByRole("button", { name: "Retained box", exact: true })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Open projects", exact: true }));
  await click(page.getByRole("button", { name: "Manage Retained", exact: true }));
  await click(page.getByRole("menuitem", { name: "Delete", exact: true }));
  await click(
    page
      .getByRole("dialog", { name: "Delete project?", exact: true })
      .getByRole("button", { name: "Delete", exact: true }),
  );
  await expect.poll(() => window.location.pathname).toMatch(/^\/projects\/temp-/);
  await click(page.getByRole("button", { name: "Close projects", exact: true }));
  await expect.element(page.getByRole("button", { name: "Retained box", exact: true })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Save", exact: true }));
  await expect.poll(() => documents.size).toBe(1);
  const id = [...documents.keys()][0]!;
  expect(id).not.toBe("deleted");
  await expect.poll(() => window.location.pathname).toBe(`/projects/${id}`);
});

test("new project from the manager gets a fresh temporary route rather than overwriting the saved project", async () => {
  documents.set("saved", savedScene("Saved"));
  window.history.replaceState(null, "", "/projects/saved");
  await mount();
  await expect.element(page.getByRole("button", { name: "Saved box", exact: true })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Open projects", exact: true }));
  await click(page.getByRole("button", { name: "New project", exact: true }));
  await expect.poll(() => window.location.pathname).toMatch(/^\/projects\/temp-/);
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  expect(documents.get("saved")?.objects).toHaveLength(1);
  expect(vi.mocked(store).save.mock.calls).toHaveLength(0);
});