import { PanelsTopLeft, PanelBottom, PanelLeft, PanelRight, PanelTop, Square, SquareDashed } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StandardView } from "@open-3d/viewport-three";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

const views = [
  { view: "front", icon: Square },
  { view: "back", icon: SquareDashed },
  { view: "left", icon: PanelLeft },
  { view: "right", icon: PanelRight },
  { view: "top", icon: PanelTop },
  { view: "bottom", icon: PanelBottom },
] as const;

export function ViewShortcuts({ onAlignView }: { onAlignView: (view: StandardView) => void }) {
  const { t } = useTranslation("workspace");
  return (
    <div className="view-shortcuts">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger render={<Button variant="ghost" />}>
          <PanelsTopLeft />
          {t("standardView")}
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label={t("standardView")} className="view-shortcut-menu min-w-0 w-max">
          {views.map(({ view, icon: Icon }) => (
            <DropdownMenuItem key={view} onClick={() => onAlignView(view)}>
              <Icon />
              {t(`${view}View`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}