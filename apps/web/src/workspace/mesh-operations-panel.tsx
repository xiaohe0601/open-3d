import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import type { MeshOperation } from "./modeling";
import { meshOperations } from "./modeling";
import { useTranslation } from "react-i18next";
import { describeModelingError, meshOperationLabelKeys } from "./localization";
import { PropertySection } from "./property-section";

interface OperationEligibility {
  blockers: { code: string; message: string }[];
}

interface MeshOperationsPanelProps {
  operation: MeshOperation;
  values: Record<string, number | string | boolean>;
  edgeIds: string[];
  eligibility: OperationEligibility | null;
  onOperationChange: (operation: MeshOperation) => void;
  onValuesChange: (values: Record<string, number | string | boolean>) => void;
  onApply: () => void;
}

export function MeshOperationsPanel({
  operation,
  values,
  edgeIds,
  eligibility,
  onOperationChange,
  onValuesChange,
  onApply,
}: MeshOperationsPanelProps) {
  const { t: tm } = useTranslation("modeling");
  const updateValue = (key: string, value: number | string | boolean) => {
    onValuesChange({ ...values, [key]: value });
  };

  const numberField = (label: string, key: string, fallback: number, step = "0.1", min?: number, max?: number) => (
    <label className="operation-field grid min-w-0 gap-1 text-[13px] text-muted" key={key}>
      <span>{label}</span>
      <Input
        type="number"
        step={step}
        min={min}
        max={max}
        value={String(values[key] ?? fallback)}
        onChange={(event) => updateValue(key, Number(event.target.value))}
      />
    </label>
  );

  function renderParameters() {
    switch (operation) {
      case "mesh.extrude":
        return (
          <div className="operation-fields grid grid-cols-2 gap-[7px] [&>label:only-child]:col-span-full">
            {numberField(tm("distance"), "distance", 1)}
            {(["X", "Y", "Z"] as const).map((axis, index) =>
              numberField(tm("direction", { axis }), `direction${axis}`, index === 2 ? 1 : 0),
            )}
          </div>
        );
      case "mesh.insetFaces":
        return (
          <div className="operation-fields grid grid-cols-2 gap-[7px] [&>label:only-child]:col-span-full">
            {numberField(tm("offset"), "offset", 0.1)}
          </div>
        );
      case "mesh.mergeVertices":
        return (
          <label className="operation-field grid min-w-0 gap-1 text-[13px] text-muted">
            <span>{tm("target")}</span>
            <Select
              value={String(values.target ?? "center")}
              onValueChange={(target) => {
                if (target) updateValue("target", target);
              }}
            >
              <SelectTrigger aria-label={tm("target")}>
                <SelectValue>{tm(values.target === "last-selected" ? "lastSelected" : "center")}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="center">{tm("center")}</SelectItem>
                <SelectItem value="last-selected">{tm("lastSelected")}</SelectItem>
              </SelectContent>
            </Select>
          </label>
        );
      case "mesh.dissolveEdges":
        return (
          <label className="operation-check flex items-center gap-1.5 text-[13px] text-muted">
            <Checkbox
              checked={Boolean(values.preserveBoundary ?? true)}
              onCheckedChange={(checked) => updateValue("preserveBoundary", checked === true)}
            />
            <span>{tm("preserveBoundary")}</span>
          </label>
        );
      case "mesh.bevelEdges":
        return (
          <div className="operation-fields grid grid-cols-2 gap-[7px] [&>label:only-child]:col-span-full">
            {numberField(tm("width"), "width", 0.1, "0.01", 0.001)}
            {numberField(tm("segments"), "segments", 1, "1", 1, 32)}
          </div>
        );
      case "mesh.loopCut":
        return (
          <div className="operation-fields grid grid-cols-2 gap-[7px] [&>label:only-child]:col-span-full">
            <label className="operation-field grid min-w-0 gap-1 text-[13px] text-muted">
              <span>{tm("seedEdge")}</span>
              <Select
                value={String(values.edgeId ?? edgeIds[0] ?? "")}
                onValueChange={(edgeId) => {
                  if (edgeId) updateValue("edgeId", edgeId);
                }}
              >
                <SelectTrigger aria-label={tm("seedEdge")}>
                  <SelectValue>{edgeIds.indexOf(String(values.edgeId ?? edgeIds[0])) + 1}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {edgeIds.map((edgeId, index) => (
                    <SelectItem value={edgeId} key={edgeId}>
                      {index + 1}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {numberField(tm("cuts"), "cuts", 1, "1", 1, 64)}
            {numberField(tm("position"), "position", 0.5, "0.01", 0.001, 0.999)}
          </div>
        );
      case "mesh.recalculateNormals":
        return <p className="mt-[5px] block text-[13px] text-muted">{tm("recalculateNormalsDescription")}</p>;
      case "mesh.flipNormals":
        return <p className="mt-[5px] block text-[13px] text-muted">{tm("flipNormalsDescription")}</p>;
    }
  }

  const blockers = eligibility?.blockers.filter(({ code }) => code !== "invalid-arguments") ?? [];

  return (
    <PropertySection title={tm("meshOperations")}>
      <label className="operation-select grid min-w-0 gap-1 text-[13px] text-muted">
        <span>{tm("operation")}</span>
        <Select value={operation} onValueChange={(value) => onOperationChange(value as MeshOperation)}>
          <SelectTrigger aria-label={tm("operation")}>
            <SelectValue>{tm(meshOperationLabelKeys[operation])}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {meshOperations.map(([id]) => (
              <SelectItem value={id} key={id}>
                {tm(meshOperationLabelKeys[id])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {renderParameters()}
      {blockers.length > 0 && (
        <ul className="eligibility-list m-0 grid gap-[5px] pl-[15px] text-[13px] leading-[1.4] text-warning [&_code]:font-semibold [&_code]:text-warning">
          {blockers.map(({ code }) => (
            <li key={code}>{describeModelingError(code)}</li>
          ))}
        </ul>
      )}
      <Button
        className="h-8 w-full rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary-hover"
        onClick={onApply}
      >
        {tm("applyOperation")}
      </Button>
    </PropertySection>
  );
}