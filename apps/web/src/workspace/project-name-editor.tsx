import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { projectNameSchema } from "../lib/ui-schemas";

export function ProjectNameEditor({
  name,
  dirty,
  onRename,
}: {
  name: string;
  dirty: boolean;
  onRename: (name: string) => void;
}) {
  const { t } = useTranslation("projects");
  const { t: tw } = useTranslation("workspace");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  function finish(commit: boolean, restoreFocus: boolean) {
    if (finished.current) return;
    const parsed = projectNameSchema.safeParse(draft);
    if (commit && !parsed.success && restoreFocus) {
      setInvalid(true);
      return;
    }
    finished.current = true;
    if (commit && parsed.success && parsed.data !== name) onRename(parsed.data);
    setEditing(false);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  }
  return (
    <div className="project-name relative min-w-0 max-w-48 shrink max-[600px]:max-w-[min(160px,calc(100vw-210px))]">
      {editing ? (
        <>
          <Input
            ref={input}
            value={draft}
            aria-label={t("projectName")}
            aria-invalid={invalid}
            aria-describedby={invalid ? "project-name-error" : undefined}
            autoComplete="off"
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setInvalid(false);
            }}
            onBlur={() => finish(true, false)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault();
                finish(event.key === "Enter", true);
              }
            }}
          />
          {invalid && (
            <span
              id="project-name-error"
              role="alert"
              className="absolute top-full left-0 z-20 mt-1 whitespace-nowrap rounded-md bg-sheet px-2 py-1 text-xs text-destructive shadow-sm"
            >
              {t("nameRequired")}
            </span>
          )}
        </>
      ) : (
        <Button
          ref={trigger}
          variant="ghost"
          className="w-full min-w-0 justify-start gap-2 px-1.5 text-[13px] font-medium"
          aria-label={t("renameProject")}
          title={t("renameProject")}
          onClick={() => {
            finished.current = false;
            setDraft(name);
            setInvalid(false);
            setEditing(true);
          }}
        >
          <span className="truncate">{name}</span>
          <Pencil className="size-3.5 shrink-0 text-muted" />
          {dirty && (
            <span className="draft-dot size-1.5 shrink-0 rounded-full bg-warning" aria-label={tw("unsavedChanges")} />
          )}
        </Button>
      )}
    </div>
  );
}