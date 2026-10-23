import { useRef } from "react";
import { Box, ChevronDown, Download, FileBox, FileJson, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GltfFormat } from "@open-3d/projects/gltf";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";

interface ProjectTransferControlsProps {
  onImport: (files: File[]) => void;
  onExport: (format: GltfFormat | "native") => void;
  error: string | null;
  onClearError: () => void;
}

export function ProjectTransferControls({ onImport, onExport, error, onClearError }: ProjectTransferControlsProps) {
  const { t } = useTranslation("projects");
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        tabIndex={-1}
        multiple
        className="sr-only"
        aria-label={t("files")}
        accept=".open3d,.glb,.gltf,application/vnd.open-3d.project+json,model/gltf-binary,model/gltf+json,application/json"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length) onImport(files);
        }}
      />
      <Button
        variant="ghost"
        className="max-[600px]:w-8"
        onClick={() => input.current?.click()}
        aria-label={t("import")}
        title={t("import")}
      >
        <Download className="size-4" />
        <span className="max-[600px]:hidden">{t("importAction")}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" className="max-[600px]:w-8" />} title={t("exportAction")}>
          <Upload className="size-4" />
          <span className="max-[600px]:sr-only">{t("exportAction")}</span>
          <ChevronDown className="size-3.5 max-[600px]:hidden" />
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label={t("exportAction")} className="w-[min(300px,calc(100vw-32px))]">
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                { format: "native", label: "open3d", Icon: FileBox },
                { format: "glb", label: "GLB", Icon: Box },
                { format: "gltf", label: "glTF", Icon: FileJson },
              ] as const
            ).map(({ format, label, Icon }) => (
              <DropdownMenuItem
                key={format}
                className="cursor-pointer justify-center border border-border bg-sheet py-2 font-medium hover:bg-soft active:bg-selection"
                onClick={() => onExport(format)}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </DropdownMenuItem>
            ))}
          </div>
          <p className="m-0 px-2 pt-2 pb-1 text-xs leading-5 text-muted">{t("transferDescription")}</p>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={Boolean(error)}
        onOpenChange={(open) => {
          if (!open) onClearError();
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>{t("fileError")}</DialogTitle>
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={onClearError} aria-label={t("closeFileError")}>
              {t("cancel")}
            </Button>
            <Button onClick={() => onExport("native")}>{t("exportCurrent")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}