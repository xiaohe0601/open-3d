import { useTranslation } from "react-i18next";
import { useEffect, useState, type FormEvent } from "react";
import { ChevronDown, Settings2, ShieldCheck, Trash2, X } from "lucide-react";
import { loadAIProviderSettings, removeAIProviderCredential, saveAIProviderSettings } from "@open-3d/ai/settings";
import type { AIProviderSettings } from "@open-3d/ai/settings";
import { Button } from "../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { AIProviderSponsors } from "./ai-provider-sponsors";

interface AIProviderSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SettingsField = keyof AIProviderSettings;
type SettingsDraft = { protocol: "openai-compatible"; baseURL: string; modelId: string; apiKey: string };

const emptySettings: SettingsDraft = {
  protocol: "openai-compatible",
  baseURL: "",
  modelId: "",
  apiKey: "",
};

export function AIProviderSettingsDialog({ open, onOpenChange }: AIProviderSettingsDialogProps) {
  const { t } = useTranslation("ai");
  const [draft, setDraft] = useState<SettingsDraft>(emptySettings);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SettingsField, string>>>({});
  const [storageError, setStorageError] = useState<"storageError" | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [hasSavedCredential, setHasSavedCredential] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNoticeOpen(false);
    setFieldErrors({});
    setStorageError(null);
    try {
      const settings = loadAIProviderSettings();
      setHasSavedCredential(Boolean(settings?.apiKey));
      setDraft(settings ? { ...settings, apiKey: settings.apiKey ?? "" } : emptySettings);
    } catch {
      setHasSavedCredential(false);
      setDraft(emptySettings);
      setStorageError("storageError");
    }
  }, [open]);

  function updateField(field: SettingsField, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setStorageError(null);
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStorageError(null);
    try {
      const result = saveAIProviderSettings(draft);
      if (!result.success) {
        setFieldErrors(result.fieldErrors);
        return;
      }
      setDraft({ ...result.data, apiKey: result.data.apiKey ?? "" });
      setHasSavedCredential(Boolean(result.data.apiKey));
      setFieldErrors({});
      onOpenChange(false);
    } catch {
      setStorageError("storageError");
    }
  }

  function removeCredential() {
    setStorageError(null);
    try {
      removeAIProviderCredential();
      setDraft((current) => ({ ...current, apiKey: "" }));
      setHasSavedCredential(false);
    } catch {
      setStorageError("storageError");
    }
  }

  const endpointErrorId = fieldErrors.baseURL ? "ai-endpoint-error" : undefined;
  const modelErrorId = fieldErrors.modelId ? "ai-model-error" : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-32px)] w-[min(480px,calc(100vw-32px))] max-w-none flex-col overflow-hidden p-0"
      >
        <DialogHeader>
          <div>
            <DialogTitle>{t("providerSettings")}</DialogTitle>
          </div>
          <DialogClose
            render={<Button className="text-muted" variant="ghost" size="icon" aria-label={t("closeSettings")} />}
          >
            <X size={16} />
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 space-y-[14px] overflow-y-auto overscroll-contain px-5 pt-1 pb-5">
          <Collapsible
            open={noticeOpen}
            onOpenChange={setNoticeOpen}
            className="rounded-md bg-warning-soft text-warning"
          >
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  className="group h-auto min-h-8 w-full justify-start gap-2 whitespace-normal px-2 py-1.5 text-left text-[13px] text-warning hover:bg-warning/10"
                />
              }
            >
              <ShieldCheck className="size-4" />
              <span id="ai-credential-summary" className="flex-1">
                {t("credentialSummary")}
              </span>
              <ChevronDown className="size-3.5 transition-transform duration-200 group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p id="ai-credential-notice" className="m-0 px-3 pt-1 pb-3 text-[13px] leading-6">
                {t("credentialNotice")}
              </p>
            </CollapsibleContent>
          </Collapsible>
          <form className="ai-settings-form grid gap-[14px]" onSubmit={saveSettings} noValidate>
            <div className="ai-settings-field grid min-w-0 gap-1.5">
              <label className="flex items-center gap-1.5 text-[13px] font-medium" htmlFor="ai-protocol">
                {t("protocol")}
              </label>
              <Select
                value={draft.protocol}
                onValueChange={(value) => {
                  if (value === "openai-compatible") updateField("protocol", value);
                }}
              >
                <SelectTrigger id="ai-protocol" aria-label={t("protocol")} className="w-full">
                  <SelectValue>{t("protocolName")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai-compatible">{t("protocolName")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="ai-settings-field grid min-w-0 gap-1.5">
              <label className="flex items-center gap-1.5 text-[13px] font-medium" htmlFor="ai-endpoint">
                {t("endpoint")}
              </label>
              <Input
                id="ai-endpoint"
                name="baseURL"
                type="url"
                autoComplete="url"
                placeholder="https://api.openai.com/v1"
                value={draft.baseURL}
                aria-invalid={Boolean(fieldErrors.baseURL)}
                aria-describedby={endpointErrorId}
                onChange={(event) => updateField("baseURL", event.currentTarget.value)}
              />
              {fieldErrors.baseURL && (
                <span className="text-[13px] leading-[1.4] text-destructive" id={endpointErrorId}>
                  {t(!draft.baseURL.trim() ? "endpointRequired" : "endpointInvalid")}
                </span>
              )}
            </div>
            <div className="ai-settings-field grid min-w-0 gap-1.5">
              <label className="flex items-center gap-1.5 text-[13px] font-medium" htmlFor="ai-model">
                {t("model")}
              </label>
              <Input
                id="ai-model"
                name="modelId"
                autoComplete="off"
                placeholder={t("modelPlaceholder")}
                value={draft.modelId}
                aria-invalid={Boolean(fieldErrors.modelId)}
                aria-describedby={modelErrorId}
                onChange={(event) => updateField("modelId", event.currentTarget.value)}
              />
              {fieldErrors.modelId && (
                <span className="text-[13px] leading-[1.4] text-destructive" id={modelErrorId}>
                  {t("modelRequired")}
                </span>
              )}
            </div>
            <div className="ai-settings-field grid min-w-0 gap-1.5">
              <label className="flex items-center gap-1.5 text-[13px] font-medium" htmlFor="ai-api-key">
                {t("apiKey")}
                <span className="text-[13px] font-normal text-muted">{t("optional")}</span>
              </label>
              <Input
                id="ai-api-key"
                name="apiKey"
                type="password"
                autoComplete="new-password"
                aria-describedby={noticeOpen ? "ai-credential-summary ai-credential-notice" : "ai-credential-summary"}
                placeholder={t("keyPlaceholder")}
                value={draft.apiKey}
                onChange={(event) => updateField("apiKey", event.currentTarget.value)}
              />
            </div>
            {storageError && (
              <p className="my-0 text-[13px] leading-[1.4] text-destructive" role="alert">
                {t("storageError")}
              </p>
            )}
            <div className="dialog-actions flex flex-wrap items-center justify-between gap-2 pt-1">
              {hasSavedCredential ? (
                <Button type="button" variant="destructive" onClick={removeCredential}>
                  <Trash2 size={14} />
                  {t("removeCredential")}
                </Button>
              ) : (
                <span />
              )}
              <Button type="submit" variant="default">
                <Settings2 size={14} />
                {t("saveSettings")}
              </Button>
            </div>
          </form>
          {open && <AIProviderSponsors />}
        </div>
      </DialogContent>
    </Dialog>
  );
}