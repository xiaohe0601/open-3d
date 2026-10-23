import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button";
import type { ConversationImage } from "./ai-conversation-message";

export function AIImageAttachments({
  images,
  onRemove,
}: {
  images: readonly ConversationImage[];
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation("ai");
  return (
    <div className="ai-image-attachments flex max-h-28 shrink-0 flex-wrap gap-2 overflow-y-auto p-1">
      {images.map((image) => (
        <div key={image.id} className="relative size-16 shrink-0">
          <img
            src={image.dataUrl}
            alt={image.name}
            className="size-full rounded-md border border-border object-cover"
          />
          {onRemove && (
            <Button
              type="button"
              size="icon-xs"
              variant="outline"
              className="absolute -top-1 -right-1"
              aria-label={t("removeImage", { name: image.name })}
              onClick={() => onRemove(image.id)}
            >
              <X />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}