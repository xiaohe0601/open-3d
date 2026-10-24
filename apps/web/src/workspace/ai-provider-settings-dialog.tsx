import { useTranslation } from "react-i18next";
import { useEffect, useState, type FormEvent } from "react";
import { ChevronDown, Settings2, ShieldAlert, Trash2, X } from "lucide-react";
import {
  AI_PROTOCOLS,
  loadAIProviderSettings,
  removeAIProviderCredential,
  removeAIGatewayCredential,
  saveAIProviderSettings,
} from "@open-3d/ai/settings";
import type { AIProviderSettings, AIProviderSettingsField } from "@open-3d/ai/settings";
import { Button } from "../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { AIProviderSponsors } from "./ai-provider-sponsors";
import { officialGatewayAvailable } from "../modra/controller/official-gateway";

interface AIProviderSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SettingsField = AIProviderSettingsField;
type SettingsDraft = {
  protocol: AIProviderSettings["protocol"];
  route: AIProviderSettings["route"];
  baseURL: string;
  modelId: string;
  apiKey: string;
  contextWindowTokens?: number | string;
  gatewayURL?: string;
  gatewayToken?: string;
};

const emptySettings: SettingsDraft = {
  protocol: "openai-compatible",
  route: "direct",
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
  const [hasSavedGatewayCredential, setHasSavedGatewayCredential] = useState(false);
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!open) return;
    setNoticeOpen(false);
    setFieldErrors({});
    setStorageError(null);
    try {
      const settings = loadAIProviderSettings();
      setHasSavedCredential(Boolean(settings?.apiKey));
      setHasSavedGatewayCredential(settings?.route === "self-hosted" && Boolean(settings.gatewayToken));
      setDraft(settings ? { ...settings, apiKey: settings.apiKey ?? "" } : emptySettings);
    } catch {
      setHasSavedCredential(false);
      setHasSavedGatewayCredential(false);
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
      if (draft.route === "official" && !officialGatewayAvailable) {
        setFieldErrors({ route: "unavailable" });
        return;
      }
      const { gatewayURL, gatewayToken, contextWindowTokens, ...values } = draft;
      const base = {
        ...values,
        ...(contextWindowTokens !== undefined && contextWindowTokens !== ""
          ? { contextWindowTokens: Number(contextWindowTokens) }
          : {}),
      };
      const result = saveAIProviderSettings(
        draft.route === "self-hosted" ? { ...base, gatewayURL, gatewayToken } : base,
      );
      if (!result.success) {
        setFieldErrors(result.fieldErrors);
        return;
      }
      setDraft({ ...result.data, apiKey: result.data.apiKey ?? "" });
      setHasSavedCredential(Boolean(result.data.apiKey));
      setHasSavedGatewayCredential(result.data.route === "self-hosted" && Boolean(result.data.gatewayToken));
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

  function removeGatewayCredential() {
    setStorageError(null);
    try {
      removeAIGatewayCredential();
      setDraft((current) => ({ ...current, gatewayToken: "" }));
      setHasSavedGatewayCredential(false);
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
        className="ai-settings-group flex h-[min(720px,calc(100dvh-32px))] w-[min(480px,calc(100vw-32px))] max-w-none flex-col gap-2 overflow-visible border-0 bg-transparent p-0 shadow-none lg:flex-row lg:gap-4 lg:has-[.ai-provider-sponsors]:w-[816px]"
      >
        <div className="ai-settings-dialog flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-sheet shadow-lg">
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
          <div className="ai-settings-layout flex min-h-0 flex-1 flex-col">
            <div className="ai-settings-scroll min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain px-5 pt-1 pb-5">
              <Collapsible
                open={noticeOpen}
                onOpenChange={setNoticeOpen}
                className="rounded-md bg-warning-soft text-warning"
              >
                <CollapsibleTrigger
                  render={
                    <Button
                      variant="ghost"
                      className="group h-auto min-h-8 w-full justify-start gap-2 whitespace-normal px-2 py-1.5 text-left text-[13px] text-warning hover:bg-warning/10 aria-expanded:bg-transparent aria-expanded:hover:bg-warning/10"
                    />
                  }
                >
                  <ShieldAlert className="size-4" />
                  <span id="ai-credential-summary" className="flex-1">
                    {t("credentialSummary")}
                  </span>
                  <ChevronDown className="size-3.5 transition-transform duration-200 group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <p id="ai-credential-notice" className="m-0 px-3 py-1 text-[13px] leading-6">
                    {t("credentialNotice")}
                  </p>
                </CollapsibleContent>
              </Collapsible>
              <form
                id="ai-provider-form"
                className="ai-settings-form grid gap-[14px]"
                onSubmit={saveSettings}
                noValidate
              >
                <div className="ai-settings-field grid min-w-0 gap-1.5">
                  <label className="flex items-center gap-1.5 text-[13px] font-medium" htmlFor="ai-protocol">
                    {t("protocol")}
                  </label>
                  <Select
                    value={draft.protocol}
                    onValueChange={(value) => {
                      if (AI_PROTOCOLS.some((protocol) => protocol === value)) updateField("protocol", value!);
                    }}
                  >
                    <SelectTrigger id="ai-protocol" aria-label={t("protocol")} className="w-full">
                      <SelectValue>{t(`protocolNames.${draft.protocol}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {AI_PROTOCOLS.map((protocol) => (
                        <SelectItem key={protocol} value={protocol}>
                          {t(`protocolNames.${protocol}`)}
                        </SelectItem>
                      ))}
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
                    placeholder={
                      {
                        "openai-compatible": "https://api.openai.com/v1",
                        "openai-responses": "https://api.openai.com/v1",
                        "anthropic-messages": "https://api.anthropic.com/v1",
                        gemini: "https://generativelanguage.googleapis.com/v1beta",
                      }[draft.protocol]
                    }
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
                    aria-describedby={
                      noticeOpen ? "ai-credential-summary ai-credential-notice" : "ai-credential-summary"
                    }
                    placeholder={t("keyPlaceholder")}
                    value={draft.apiKey}
                    onChange={(event) => updateField("apiKey", event.currentTarget.value)}
                  />
                </div>
                <div className="ai-settings-connection grid gap-[14px] border-t border-border pt-4">
                  <div className="ai-settings-field grid min-w-0 gap-1.5">
                    <label className="text-[13px] font-medium" htmlFor="ai-route">
                      {t("route")}
                    </label>
                    <Select
                      value={draft.route}
                      onValueChange={(value) => {
                        if (
                          value === "direct" ||
                          value === "self-hosted" ||
                          (value === "official" && officialGatewayAvailable)
                        )
                          updateField("route", value);
                      }}
                    >
                      <SelectTrigger id="ai-route" aria-label={t("route")} className="w-full">
                        <SelectValue>{t(`routes.${draft.route}`)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="direct">{t("routes.direct")}</SelectItem>
                        <SelectItem value="official" disabled={!officialGatewayAvailable}>
                          {t("routes.official")}
                        </SelectItem>
                        <SelectItem value="self-hosted">{t("routes.self-hosted")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="m-0 text-[13px] leading-5 text-muted">{t(`routeNotice.${draft.route}`)}</p>
                    {fieldErrors.route && (
                      <p role="alert" className="m-0 text-[13px] text-destructive">
                        {t("officialUnavailable")}
                      </p>
                    )}
                  </div>
                  {draft.route === "self-hosted" && (
                    <>
                      <div className="ai-settings-field grid min-w-0 gap-1.5">
                        <label className="text-[13px] font-medium" htmlFor="ai-gateway-url">
                          {t("gatewayURL")}
                        </label>
                        <Input
                          id="ai-gateway-url"
                          type="url"
                          value={draft.gatewayURL ?? ""}
                          autoComplete="off"
                          placeholder="https://your-gateway.workers.dev"
                          aria-invalid={Boolean(fieldErrors.gatewayURL)}
                          onChange={(event) => updateField("gatewayURL", event.currentTarget.value)}
                        />
                        {fieldErrors.gatewayURL && (
                          <p role="alert" className="m-0 text-[13px] text-destructive">
                            {t("gatewayURLInvalid")}
                          </p>
                        )}
                      </div>
                      <div className="ai-settings-field grid min-w-0 gap-1.5">
                        <label className="text-[13px] font-medium" htmlFor="ai-gateway-token">
                          {t("gatewayToken")} <span className="font-normal text-muted">{t("optional")}</span>
                        </label>
                        <Input
                          id="ai-gateway-token"
                          type="password"
                          autoComplete="new-password"
                          value={draft.gatewayToken ?? ""}
                          onChange={(event) => updateField("gatewayToken", event.currentTarget.value)}
                        />
                        {hasSavedGatewayCredential && (
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={removeGatewayCredential}
                            className="justify-self-start"
                          >
                            <Trash2 size={14} />
                            {t("removeGatewayCredential")}
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <details className="text-[13px]">
                  <summary className="cursor-pointer text-muted">{t("contextSettings")}</summary>
                  <div className="mt-3 grid gap-1.5">
                    <label htmlFor="ai-context-window">{t("contextWindowTokens")}</label>
                    <div className="relative">
                      <Input
                        id="ai-context-window"
                        className="[appearance:textfield] pr-16 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        type="number"
                        min={16384}
                        max={2000000}
                        step={1}
                        placeholder="32768"
                        value={draft.contextWindowTokens ?? ""}
                        aria-invalid={Boolean(fieldErrors.contextWindowTokens)}
                        aria-describedby="ai-context-window-notice"
                        onChange={(event) => updateField("contextWindowTokens", event.currentTarget.value)}
                      />
                      <span
                        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[12px] text-muted"
                        aria-hidden="true"
                      >
                        {t("contextTokenUnit")}
                      </span>
                    </div>
                    <p id="ai-context-window-notice" className="m-0 text-[12px] text-muted">
                      {t("contextWindowNotice")}
                    </p>
                    {fieldErrors.contextWindowTokens && (
                      <span role="alert" className="text-destructive">
                        {t("contextWindowInvalid")}
                      </span>
                    )}
                  </div>
                </details>
                {storageError && (
                  <p className="my-0 text-[13px] leading-[1.4] text-destructive" role="alert">
                    {t("storageError")}
                  </p>
                )}
              </form>
              {open && !desktop && <AIProviderSponsors />}
            </div>
          </div>
          <div className="dialog-actions flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
            {hasSavedCredential ? (
              <Button type="button" variant="destructive" onClick={removeCredential}>
                <Trash2 size={14} />
                {t("removeCredential")}
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" form="ai-provider-form" variant="default">
              <Settings2 size={14} />
              {t("saveSettings")}
            </Button>
          </div>
        </div>
        {open && desktop && <AIProviderSponsors />}
      </DialogContent>
    </Dialog>
  );
}