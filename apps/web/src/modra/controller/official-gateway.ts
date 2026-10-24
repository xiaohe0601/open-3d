/** The hosted relay is configured per web deployment. */
export const officialGatewayURL = import.meta.env.VITE_MODRA_GATEWAY_URL?.trim() || undefined;
export const officialTurnstileSiteKey = import.meta.env.VITE_MODRA_TURNSTILE_SITE_KEY?.trim() || undefined;
export const officialGatewayAvailable = Boolean(officialGatewayURL && officialTurnstileSiteKey);