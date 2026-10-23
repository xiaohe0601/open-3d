import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { requiredInputClasses, topologyContracts } from "./contracts.mjs";

test("every MVP mesh operation has parameters, eligibility, and contract cases", () => {
  const operations = new Set(topologyContracts.map(({ operation }) => operation));

  assert.deepEqual([...operations].sort(), [
    "bevel.edges",
    "dissolve.edges",
    "dissolve.faces",
    "extrude.edges",
    "extrude.faces",
    "extrude.vertices",
    "inset.faces",
    "loopCut.quads",
    "merge.vertices",
    "normals.flip",
    "normals.recalculate",
  ]);

  for (const contract of topologyContracts) {
    assert.ok(Object.keys(contract.parameters).length > 0, `${contract.operation} parameters`);
    assert.ok(contract.eligibility.length > 0, `${contract.operation} eligibility`);
    assert.ok(
      contract.cases.some(({ accepted }) => accepted),
      `${contract.operation} accepted case`,
    );
    assert.ok(
      contract.cases.some(({ accepted }) => !accepted),
      `${contract.operation} rejected case`,
    );

    for (const scenario of contract.cases) {
      assert.ok(scenario.id, `${contract.operation} case id`);
      assert.ok(scenario.input, `${contract.operation} fixture input`);
      if (scenario.accepted) {
        assert.ok(scenario.expected, `${contract.operation}/${scenario.id} expected topology or result`);
      } else {
        assert.ok(scenario.reason, `${contract.operation}/${scenario.id} rejection reason`);
      }
    }
  }
});

test("contract fixtures cover boundary, disconnected, non-manifold, and degenerate inputs", () => {
  const inputs = topologyContracts.flatMap(({ cases }) => cases.map(({ input }) => input));

  const classPatterns = {
    boundary: /boundary|open-/,
    disconnected: /disconnected/,
    "non-manifold": /non-manifold/,
    degenerate: /degenerate|zero-area/,
  };

  for (const inputClass of requiredInputClasses) {
    assert.ok(
      inputs.some((input) => classPatterns[inputClass].test(input)),
      `missing ${inputClass} fixture`,
    );
  }
});

test("invalid topology contracts are explicit rejection cases", () => {
  const rejectedCases = topologyContracts.flatMap(({ operation, cases }) =>
    cases.filter(({ accepted }) => !accepted).map(({ id, reason }) => ({ operation, id, reason })),
  );

  assert.ok(rejectedCases.length >= 10);
  assert.ok(rejectedCases.some(({ reason }) => reason === "boundary-edge"));
  assert.ok(rejectedCases.some(({ reason }) => reason === "non-manifold-edge"));
  assert.ok(rejectedCases.some(({ reason }) => reason === "degenerate-face"));
  assert.ok(rejectedCases.some(({ reason }) => reason === "disconnected-selection"));
});