import { createModraProvider } from "@open-3d/ai";
import { loadAIProviderSettings } from "@open-3d/ai/settings";
import { ModraRuntime } from "@open-3d/ai/runtime";
import { createModraTransport, createOfficialGatewayAccess } from "@open-3d/ai/transport";
import type { ModraTransport } from "@open-3d/ai/transport";
import type { RuntimeFactory } from "./durable-session";
import type { WorkspaceModelingHost } from "./workspace-host";
import { officialGatewayURL } from "./official-gateway";
import { captureSceneEvidence } from "../storage/scene-evidence";

/** Credentials are resolved at dispatch; snapshots contain only nonsecret connection references. */
export function browserRuntimeFactory(
  host: WorkspaceModelingHost,
  challenge: (signal?: AbortSignal | null) => Promise<string>,
  transport: ModraTransport = browserTransport(challenge),
): RuntimeFactory {
  const currentSettings = () => {
    const settings = loadAIProviderSettings();
    if (!settings) throw new Error("Provider not configured");
    return settings;
  };
  return (state, repository, assets) =>
    new ModraRuntime(state, {
      host,
      clock: { now: Date.now, id: () => crypto.randomUUID() },
      transport,
      repository,
      evidence: { capture: captureSceneEvidence },
      credentials: {
        resolve: (connection) => {
          const settings = currentSettings();
          if (
            connection.configuration &&
            (connection.protocol !== settings.protocol ||
              connection.route !== settings.route ||
              connection.configuration.baseURL !== settings.baseURL ||
              connection.configuration.modelId !== settings.modelId ||
              (connection.configuration.contextWindowTokens ?? 32768) !== (settings.contextWindowTokens ?? 32768) ||
              connection.configuration.gatewayURL !==
                (settings.route === "self-hosted" ? settings.gatewayURL : undefined))
          )
            throw new Error("Queued connection settings changed. Remove and requeue with the current settings.");
          return {
            revision: JSON.stringify(settings),
            apiKey: settings.apiKey,
            gatewayToken: settings.route === "self-hosted" ? settings.gatewayToken : undefined,
          };
        },
        isCurrent: (snapshot) => {
          try {
            return snapshot.revision === JSON.stringify(currentSettings());
          } catch {
            return false;
          }
        },
      },
      provider: createModraProvider({
        model: currentSettings,
        image: (asset) => {
          const image = assets.get(asset.assetId);
          if (!image) throw new Error("Image asset is unavailable");
          return image.dataUrl;
        },
      }),
    });
}

export function browserTransport(challenge: (signal?: AbortSignal | null) => Promise<string>) {
  return createModraTransport({
    settings: () => {
      const settings = loadAIProviderSettings();
      if (!settings) throw new Error("Provider not configured");
      return settings;
    },
    fetch: (...args) => globalThis.fetch(...args),
    officialURL: officialGatewayURL,
    acquireGrant: createOfficialGatewayAccess({ challenge, fetch: (...args) => globalThis.fetch(...args) }),
  });
}