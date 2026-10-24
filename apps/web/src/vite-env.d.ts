declare module "*.css";

interface ImportMetaEnv {
  readonly VITE_MODRA_GATEWAY_URL?: string;
  readonly VITE_MODRA_TURNSTILE_SITE_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}