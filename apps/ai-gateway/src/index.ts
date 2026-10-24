import { authorize, issueAccess, protection } from "./access";
import { acquire } from "./admission";
import { deploymentLimits, failure, GatewayError, limits, protocols, type Env } from "./contracts";
import { allowedOrigin, cors, preflight, protocolFrom, target, upstreamHeaders } from "./policy";
import { relay } from "./relay";

export { RelayAdmission } from "./admission";

export function createGateway(dispatch: typeof fetch = globalThis.fetch) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      let origin: string | undefined;
      try {
        origin = allowedOrigin(request, env);
        if (request.method === "OPTIONS") return cors(preflight(request), origin);
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/v1/capabilities") {
          protection(env);
          deploymentLimits(env);
          return cors(
            Response.json({
              version: 1,
              protocols,
              auth:
                env.MODE === "official"
                  ? "turnstile-grant"
                  : env.SELF_HOSTED_AUTH === "none"
                    ? "none"
                    : "deployment-token",
              enabled: env.RELAY_ENABLED === "true",
              limits: limits(env),
            }),
            origin,
          );
        }
        if (request.method !== "POST") throw new GatewayError("method", 405);
        if (!["/v1/access", "/v1/relay"].includes(path)) throw new GatewayError("not-found", 404);
        protection(env);
        if (env.RELAY_ENABLED !== "true") throw new GatewayError("disabled", 503);
        if (path === "/v1/access") return cors(await issueAccess(request, env, origin, dispatch), origin);
        const identity = await authorize(request, env, origin);
        const protocol = protocolFrom(request);
        target(request, protocol);
        upstreamHeaders(request, protocol);
        const release = await acquire(env, identity);
        try {
          return cors(await relay(request, env, dispatch, release), origin);
        } catch (error) {
          await release();
          throw error;
        }
      } catch (error) {
        const response = failure(error);
        return origin ? cors(response, origin) : response;
      }
    },
  };
}

export default createGateway() satisfies ExportedHandler<Env>;