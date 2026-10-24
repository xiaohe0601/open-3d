import { z } from "zod";

export const AI_PROVIDER_SETTINGS_CHANGED_EVENT = "open-3d-ai-settings-changed";
export const AI_PROVIDER_SETTINGS_STORAGE_KEY = "open-3d.ai.provider-settings.v2";
export const AI_PROVIDER_SETTINGS_LEGACY_KEY = "open-3d.ai.provider-settings.v1";
export const AI_PROVIDER_CREDENTIAL_EPOCH_KEY = ["open-3d", "ai", "credential-epoch", "v1"].join(".");
export const AI_GATEWAY_CREDENTIAL_EPOCH_KEY = ["open-3d", "ai", "gateway-epoch", "v1"].join(".");
export const AI_PROTOCOLS = ["openai-compatible", "openai-responses", "anthropic-messages", "gemini"] as const;
export type AIProtocol = (typeof AI_PROTOCOLS)[number];

const endpoint = z
  .string()
  .trim()
  .min(1, "Enter an endpoint URL.")
  .url("Enter a valid absolute URL.")
  .refine((value) => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }, "Use an HTTP or HTTPS URL without credentials, query parameters or fragments.")
  .transform((value) => value.replace(/\/+$/, ""));
const secret = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);
const common = z.object({
  protocol: z.enum(AI_PROTOCOLS),
  baseURL: endpoint,
  modelId: z.string().trim().min(1, "Enter a model identifier."),
  contextWindowTokens: z.number().int().min(16_384).max(2_000_000).optional(),
  apiKey: secret,
});
const legacySchema = common.extend({ protocol: z.literal("openai-compatible") }).strict();
export const aiProviderSettingsSchema = z.discriminatedUnion("route", [
  common.extend({ route: z.literal("direct") }).strict(),
  common.extend({ route: z.literal("official") }).strict(),
  common
    .extend({
      route: z.literal("self-hosted"),
      gatewayURL: endpoint.refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      }, "Use HTTPS for a public gateway."),
      gatewayToken: secret,
    })
    .strict(),
]);
export type AIProviderSettings = z.output<typeof aiProviderSettingsSchema>;
export type AIProviderSettingsField =
  | "protocol"
  | "route"
  | "baseURL"
  | "modelId"
  | "apiKey"
  | "contextWindowTokens"
  | "gatewayURL"
  | "gatewayToken";
export type AIProviderSettingsValidation =
  | { success: true; data: AIProviderSettings }
  | { success: false; fieldErrors: Partial<Record<AIProviderSettingsField, string>> };
const fields = new Set([
  "protocol",
  "route",
  "baseURL",
  "modelId",
  "apiKey",
  "gatewayURL",
  "gatewayToken",
  "contextWindowTokens",
]);
const envelopeSchema = z
  .object({
    version: z.literal(2),
    credentialEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    gatewayCredentialEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    settings: aiProviderSettingsSchema,
  })
  .strict();

export class AIProviderSettingsStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIProviderSettingsStorageError";
  }
}

export function validateAIProviderSettings(input: unknown): AIProviderSettingsValidation {
  const normalized =
    input && typeof input === "object" && !Array.isArray(input) ? { route: "direct", ...input } : input;
  const result = aiProviderSettingsSchema.safeParse(normalized);
  if (result.success) return { success: true, data: result.data };
  const fieldErrors: Partial<Record<AIProviderSettingsField, string>> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && fields.has(field)) fieldErrors[field as AIProviderSettingsField] ??= issue.message;
  }
  return { success: false, fieldErrors };
}

function parse(serialized: string) {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new AIProviderSettingsStorageError("Saved AI settings are malformed. Review browser storage.");
  }
}
function epoch(storage: Storage, key = AI_PROVIDER_CREDENTIAL_EPOCH_KEY) {
  const value = storage.getItem(key);
  if (value === null) return 0;
  const current = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(current) || current < 0)
    throw new AIProviderSettingsStorageError("The credential revocation record is invalid.");
  return current;
}
function currentEnvelope(storage: Storage) {
  const serialized = storage.getItem(AI_PROVIDER_SETTINGS_STORAGE_KEY);
  if (serialized === null) return null;
  const result = envelopeSchema.safeParse(parse(serialized));
  if (!result.success)
    throw new AIProviderSettingsStorageError(
      "AI settings are invalid or use an unsupported version. They were not overwritten.",
    );
  return result.data;
}
function protectFutureVersion(storage: Storage) {
  const serialized = storage.getItem(AI_PROVIDER_SETTINGS_STORAGE_KEY);
  if (serialized === null) return;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return; // Explicit Save may repair corrupt JSON; loading never resets it.
  }
  if (value && typeof value === "object" && "version" in value && value.version !== 2)
    throw new AIProviderSettingsStorageError("Unsupported AI settings version. They were not overwritten.");
}
function legacyRecord(storage: Storage) {
  const serialized = storage.getItem(AI_PROVIDER_SETTINGS_LEGACY_KEY);
  if (serialized === null) return null;
  try {
    return legacySchema.safeParse(JSON.parse(serialized));
  } catch {
    return null;
  }
}
function notify(storage: Storage) {
  if (typeof window !== "undefined" && storage === window.localStorage)
    window.dispatchEvent(new Event(AI_PROVIDER_SETTINGS_CHANGED_EVENT));
}
function storageError(): never {
  throw new AIProviderSettingsStorageError(
    "Could not access AI settings. Review browser storage permissions and retry.",
  );
}

export function loadAIProviderSettings(storage: Storage = window.localStorage): AIProviderSettings | null {
  try {
    const revoked = epoch(storage);
    const current = currentEnvelope(storage);
    if (current) {
      const settings =
        current.credentialEpoch === revoked ? current.settings : { ...current.settings, apiKey: undefined };
      return settings.route === "self-hosted" &&
        (current.gatewayCredentialEpoch ?? 0) !== epoch(storage, AI_GATEWAY_CREDENTIAL_EPOCH_KEY)
        ? { ...settings, gatewayToken: undefined }
        : settings;
    }
    const serialized = storage.getItem(AI_PROVIDER_SETTINGS_LEGACY_KEY);
    if (serialized === null) return null;
    const legacy = legacySchema.safeParse(parse(serialized));
    if (!legacy.success)
      throw new AIProviderSettingsStorageError("Legacy AI settings are invalid. Review and save them again.");
    const settings: AIProviderSettings = {
      ...legacy.data,
      route: "direct",
      ...(revoked > 0 ? { apiKey: undefined } : {}),
    };
    // Keep the original intact if this migration write fails. Migration never opts into a relay.
    storage.setItem(
      AI_PROVIDER_SETTINGS_STORAGE_KEY,
      JSON.stringify({ version: 2, credentialEpoch: revoked, settings }),
    );
    return settings;
  } catch (error) {
    if (error instanceof AIProviderSettingsStorageError) throw error;
    return storageError();
  }
}

export function saveAIProviderSettings(
  input: unknown,
  storage: Storage = window.localStorage,
): AIProviderSettingsValidation {
  const result = validateAIProviderSettings(input);
  if (!result.success) return result;
  try {
    protectFutureVersion(storage);
    storage.setItem(
      AI_PROVIDER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        credentialEpoch: epoch(storage),
        ...(result.data.route === "self-hosted"
          ? { gatewayCredentialEpoch: epoch(storage, AI_GATEWAY_CREDENTIAL_EPOCH_KEY) }
          : {}),
        settings: result.data,
      }),
    );
  } catch (error) {
    if (error instanceof AIProviderSettingsStorageError) throw error;
    return storageError();
  }
  notify(storage);
  return result;
}

export function removeAIProviderCredential(storage: Storage = window.localStorage): boolean {
  try {
    const current = currentEnvelope(storage);
    const legacy = legacyRecord(storage);
    const settings = current?.settings ?? (legacy?.success ? { ...legacy.data, route: "direct" as const } : null);
    if (!settings?.apiKey && !(legacy?.success && legacy.data.apiKey)) return false;
    const next = epoch(storage) + 1;
    if (!Number.isSafeInteger(next))
      throw new AIProviderSettingsStorageError("The credential revocation record cannot advance.");
    // Revoke first: interrupted cleanup must not resurrect keys from an older v2 or rollback record.
    storage.setItem(AI_PROVIDER_CREDENTIAL_EPOCH_KEY, String(next));
    notify(storage);
    if (settings)
      storage.setItem(
        AI_PROVIDER_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          version: 2,
          credentialEpoch: next,
          ...(current?.gatewayCredentialEpoch === undefined
            ? {}
            : { gatewayCredentialEpoch: current.gatewayCredentialEpoch }),
          settings: { ...settings, apiKey: undefined },
        }),
      );
    if (legacy?.success)
      storage.setItem(AI_PROVIDER_SETTINGS_LEGACY_KEY, JSON.stringify({ ...legacy.data, apiKey: undefined }));
    return true;
  } catch (error) {
    if (error instanceof AIProviderSettingsStorageError) throw error;
    return storageError();
  }
}

export function removeAIGatewayCredential(storage: Storage = window.localStorage): boolean {
  try {
    const current = currentEnvelope(storage);
    if (current?.settings.route !== "self-hosted" || !current.settings.gatewayToken) return false;
    const next = epoch(storage, AI_GATEWAY_CREDENTIAL_EPOCH_KEY) + 1;
    if (!Number.isSafeInteger(next))
      throw new AIProviderSettingsStorageError("The gateway revocation record cannot advance.");
    storage.setItem(AI_GATEWAY_CREDENTIAL_EPOCH_KEY, String(next));
    notify(storage);
    storage.setItem(
      AI_PROVIDER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...current,
        gatewayCredentialEpoch: next,
        settings: { ...current.settings, gatewayToken: undefined },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof AIProviderSettingsStorageError) throw error;
    return storageError();
  }
}