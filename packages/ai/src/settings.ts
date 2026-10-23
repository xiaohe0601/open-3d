import { z } from "zod";

export const AI_PROVIDER_SETTINGS_STORAGE_KEY = "open-3d.ai.provider-settings.v1";

export const aiProviderSettingsSchema = z
  .object({
    protocol: z.literal("openai-compatible"),
    baseURL: z
      .string()
      .trim()
      .min(1, "Enter an endpoint URL.")
      .url("Enter a valid absolute URL.")
      .refine(
        (value) => {
          try {
            const protocol = new URL(value).protocol;
            return protocol === "https:" || protocol === "http:";
          } catch {
            return false;
          }
        },
        { message: "Use an HTTP or HTTPS endpoint URL." },
      )
      .transform((value) => value.replace(/\/+$/, "")),
    modelId: z.string().trim().min(1, "Enter a model identifier."),
    apiKey: z
      .string()
      .optional()
      .transform((value) => {
        const trimmed = value?.trim();
        return trimmed || undefined;
      }),
  })
  .strict();

export type AIProviderSettings = z.output<typeof aiProviderSettingsSchema>;

export type AIProviderSettingsValidation =
  | { success: true; data: AIProviderSettings }
  | { success: false; fieldErrors: Partial<Record<keyof AIProviderSettings, string>> };

export class AIProviderSettingsStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIProviderSettingsStorageError";
  }
}

export function validateAIProviderSettings(input: unknown): AIProviderSettingsValidation {
  const result = aiProviderSettingsSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };

  const fieldErrors: Partial<Record<keyof AIProviderSettings, string>> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && field in aiProviderSettingsSchema.shape) {
      const key = field as keyof AIProviderSettings;
      fieldErrors[key] ??= issue.message;
    }
  }
  return { success: false, fieldErrors };
}

export function loadAIProviderSettings(storage: Storage = window.localStorage): AIProviderSettings | null {
  let serialized: string | null;
  try {
    serialized = storage.getItem(AI_PROVIDER_SETTINGS_STORAGE_KEY);
  } catch (error) {
    throw new AIProviderSettingsStorageError(
      error instanceof Error ? error.message : "Could not read AI provider settings from this browser.",
    );
  }
  if (serialized === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new AIProviderSettingsStorageError("Saved AI provider settings are malformed. Review and save them again.");
  }
  const result = validateAIProviderSettings(parsed);
  if (!result.success) {
    throw new AIProviderSettingsStorageError("Saved AI provider settings are invalid. Review and save them again.");
  }
  return result.data;
}

export function saveAIProviderSettings(
  input: unknown,
  storage: Storage = window.localStorage,
): AIProviderSettingsValidation {
  const result = validateAIProviderSettings(input);
  if (!result.success) return result;

  try {
    storage.setItem(AI_PROVIDER_SETTINGS_STORAGE_KEY, JSON.stringify(result.data));
  } catch (error) {
    throw new AIProviderSettingsStorageError(
      error instanceof Error ? error.message : "Could not save AI provider settings in this browser.",
    );
  }
  return result;
}

export function removeAIProviderCredential(storage: Storage = window.localStorage): boolean {
  const settings = loadAIProviderSettings(storage);
  if (!settings?.apiKey) return false;

  const result = saveAIProviderSettings({ ...settings, apiKey: undefined }, storage);
  if (!result.success) {
    throw new AIProviderSettingsStorageError("Could not remove the saved AI API key.");
  }
  return true;
}