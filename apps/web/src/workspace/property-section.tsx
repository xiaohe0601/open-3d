import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";

interface PropertySectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function PropertySection({ title, description, children }: PropertySectionProps) {
  const { t } = useTranslation("workspace");
  return (
    <Collapsible defaultOpen className="property-section border-b border-rule px-1 py-2 last:border-b-0">
      <h3 className="m-0">
        <CollapsibleTrigger
          aria-label={t("togglePropertySection", { section: title })}
          render={
            <Button
              variant="ghost"
              className="section-title group h-auto min-h-8 w-full justify-between gap-2 rounded px-1 py-1 text-left text-[13px] font-medium"
            />
          }
        >
          <span>{title}</span>
          <span className="ml-auto flex items-center gap-2">
            {description && <span className="text-[13px] font-normal text-muted">{description}</span>}
            <ChevronDown className="size-3.5 shrink-0 text-muted transition-transform duration-200 group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
          </span>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent role="region" aria-label={title}>
        <div className="grid gap-2 pt-2 pb-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}