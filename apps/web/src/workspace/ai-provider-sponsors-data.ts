export const AI_PROVIDER_SPONSORS_URL = "https://oss.xiaohe.ink/sponsors/special/open-3d.json";

export interface AIProviderSponsor {
  id: string;
  name: string;
  description: string;
  link: string;
  icon?: string;
}

function webURL(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch {
    return;
  }
}

export function parseAIProviderSponsors(data: unknown): AIProviderSponsor[] {
  if (!Array.isArray(data)) return [];
  const sponsors: AIProviderSponsor[] = [];
  const ids = new Set<string>();
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name, description, link, icon } = entry;
    const safeLink = webURL(link);
    if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim() || !safeLink) continue;
    if (ids.has(id)) continue;
    ids.add(id);
    sponsors.push({
      id,
      name: name.trim(),
      description: typeof description === "string" ? description.trim() : "",
      link: safeLink,
      icon: webURL(icon),
    });
  }
  return sponsors;
}

async function fetchAIProviderSponsors(): Promise<AIProviderSponsor[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(AI_PROVIDER_SPONSORS_URL, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error("Could not load provider sponsors.");
    return parseAIProviderSponsors(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export function createAIProviderSponsorsLoader() {
  let request: Promise<AIProviderSponsor[]> | undefined;
  // Share pending and settled requests for the page lifetime, including empty results and failures.
  return () => (request ??= fetchAIProviderSponsors());
}

export const loadAIProviderSponsors = createAIProviderSponsorsLoader();