import { Languages, Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { useWorkspaceUiStore } from "../workspace-ui-store";

export function WorkspacePreferenceControls() {
  const { t } = useTranslation("workspace");
  const { t: tc } = useTranslation("common");
  const preferences = useWorkspaceUiStore((state) => state.displayPreferences);
  const update = useWorkspaceUiStore((state) => state.updateDisplayPreferences);
  const ThemeIcon = preferences.theme === "system" ? Monitor : preferences.theme === "dark" ? Moon : Sun;
  const themeLabel = tc(preferences.theme === "system" ? "followSystem" : preferences.theme);
  const languageLabel = tc(
    preferences.language === "system"
      ? "followSystem"
      : preferences.language === "en"
        ? "english"
        : "simplifiedChinese",
  );
  return (
    <div
      className="display-preferences flex shrink-0 items-center gap-1"
      role="group"
      aria-label={t("displayPreferences")}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" />}
          aria-label={t("language")}
          title={`${t("language")}: ${languageLabel}`}
        >
          <Languages />
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label={t("language")} align="end">
          <DropdownMenuRadioGroup
            value={preferences.language}
            onValueChange={(language: unknown) => {
              if (language === "system" || language === "en" || language === "zh-CN")
                update({ ...preferences, language });
            }}
          >
            <DropdownMenuRadioItem value="system">{tc("followSystem")}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="en">{tc("english")}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="zh-CN">{tc("simplifiedChinese")}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" />}
          aria-label={t("theme")}
          title={`${t("theme")}: ${themeLabel}`}
        >
          <ThemeIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label={t("theme")} align="end">
          <DropdownMenuRadioGroup
            value={preferences.theme}
            onValueChange={(theme: unknown) => {
              if (theme === "system" || theme === "light" || theme === "dark") update({ ...preferences, theme });
            }}
          >
            <DropdownMenuRadioItem value="system">
              <Monitor />
              {tc("followSystem")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">
              <Sun />
              {tc("light")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <Moon />
              {tc("dark")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}