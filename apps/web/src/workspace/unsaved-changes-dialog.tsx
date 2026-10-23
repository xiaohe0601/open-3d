import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";

interface UnsavedChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaveAndContinue: () => void;
  onDiscard: () => void;
}

export function UnsavedChangesDialog({ open, onOpenChange, onSaveAndContinue, onDiscard }: UnsavedChangesDialogProps) {
  const { t } = useTranslation("projects");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>{t("unsavedTitle")}</DialogTitle>
        <div className="unsaved-actions mt-5 flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button variant="outline" onClick={onDiscard}>
            {t("discard")}
          </Button>
          <Button onClick={onSaveAndContinue}>{t("saveAndContinue")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}