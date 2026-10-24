import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AtSign, Crosshair, X } from "lucide-react";
import { MAX_OBJECT_REFERENCES, type ObjectReference } from "@open-3d/ai/runtime";
import type { WorkspaceModelingHost } from "../controller/workspace-host";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../../components/ui/dialog";

type DisplayReference = ObjectReference & { currentName?: string; mutationVersion?: number };

export function ObjectReferenceChips({
  references,
  onRemove,
}: {
  references: readonly DisplayReference[];
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation("ai");
  return (
    <div className="flex min-w-0 flex-wrap gap-1" aria-label={t("objectReferences")}>
      {references.map((ref) => (
        <span
          key={ref.id}
          data-object-reference={ref.id}
          title={`${ref.name} (${ref.id})${ref.mutationVersion === undefined ? "" : ` · v${ref.mutationVersion}`}`}
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-border px-1.5 text-[13px] text-muted"
        >
          <span className="min-w-0 truncate">@{ref.currentName ?? ref.name}</span>
          {onRemove && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("removeReference", { name: ref.name })}
              onClick={() => onRemove(ref.id)}
            >
              <X />
            </Button>
          )}
        </span>
      ))}
    </div>
  );
}

export function ObjectReferenceActions({
  host,
  references,
  disabled,
  onChange,
}: {
  host: WorkspaceModelingHost;
  references: readonly ObjectReference[];
  disabled: boolean;
  onChange: (references: ObjectReference[]) => void;
}) {
  const { t } = useTranslation("ai");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [snapshot, setSnapshot] = useState(() => host.snapshot());
  const [error, setError] = useState(false);
  function attach(ids: readonly string[]) {
    const current = host.snapshot();
    const next = new Map(references.map((ref) => [ref.id, ref]));
    for (const id of ids) {
      const object = current.document.objects.find((object) => object.id === id);
      if (!object) continue;
      next.set(id, {
        id,
        name: object.name.slice(0, 160),
        scopeId: current.version.scopeId,
        generationId: current.version.generationId,
        objectRevision: current.objectRevisions?.[id] ?? 0,
      });
    }
    if (next.size > MAX_OBJECT_REFERENCES) {
      setError(true);
      return false;
    }
    onChange([...next.values()]);
    setError(false);
    return true;
  }
  const matches = snapshot.document.objects.filter((object) =>
    object.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={t("mentionObject")}
        title={t("mentionObject")}
        disabled={disabled}
        onClick={() => {
          setSnapshot(host.snapshot());
          setSearch("");
          setError(false);
          setOpen(true);
        }}
      >
        <AtSign />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="flex h-[min(400px,calc(100dvh-32px))] min-h-0 flex-col overflow-hidden"
        >
          <div className="flex shrink-0 items-center justify-between gap-2">
            <DialogTitle>{t("mentionObject")}</DialogTitle>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("attachSelection")}
                title={t("attachSelection")}
                disabled={disabled || !snapshot.document.selection.objectIds.length}
                onClick={() => {
                  if (attach(host.snapshot().document.selection.objectIds)) setOpen(false);
                }}
              >
                <Crosshair />
              </Button>
              <DialogClose render={<Button variant="ghost" size="icon-sm" />} aria-label={t("closeReferences")}>
                <X />
              </DialogClose>
            </div>
          </div>
          {error && (
            <p role="alert" className="shrink-0 text-[13px] text-destructive">
              {t("referenceLimit")}
            </p>
          )}
          <Input
            className="mt-3 shrink-0"
            aria-label={t("searchObjects")}
            placeholder={t("searchObjects")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="mt-2 grid min-h-0 min-w-0 flex-1 content-start gap-1 overflow-x-hidden overflow-y-auto">
            {matches.slice(0, 50).map((object) => (
              <Button
                key={object.id}
                type="button"
                variant="ghost"
                className="min-w-0 justify-start"
                title={object.name}
                onClick={() => {
                  if (attach([object.id])) setOpen(false);
                }}
              >
                <span className="truncate">{object.name}</span>
              </Button>
            ))}
            {matches.length > 50 && <p className="text-[13px] text-muted">{t("refineObjectSearch")}</p>}
            {!matches.length && <p className="text-[13px] text-muted">{t("noReferenceObjects")}</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}