import { Box, Circle, Cylinder, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import type { Primitive } from "./modeling";

const primitives = [
  { id: "box", icon: Box },
  { id: "uv-sphere", icon: Circle },
  { id: "cylinder", icon: Cylinder },
] as const satisfies readonly { id: Primitive; icon: typeof Box }[];

export function AddObjectMenu({ onAddPrimitive }: { onAddPrimitive: (primitive: Primitive) => void }) {
  const { t } = useTranslation("creation");
  const { t: tm } = useTranslation("modeling");
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />} aria-label={t("title")} title={t("title")}>
        <Plus />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="add-object-menu min-w-0" align="end" aria-label={t("title")}>
        {primitives.map(({ id, icon: Icon }) => (
          <DropdownMenuItem
            key={id}
            aria-label={t("addPrimitive", { name: tm(`primitives.${id}`) })}
            onClick={() => onAddPrimitive(id)}
          >
            <Icon />
            {tm(`primitives.${id}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}