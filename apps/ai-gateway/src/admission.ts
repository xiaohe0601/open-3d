import { deploymentLimits, GatewayError, limits, type Env } from "./contracts";

type Leases = Record<string, number>;
const graceMs = 30_000;
const dayMs = 86_400_000;

export class RelayAdmission {
  constructor(private readonly state: DurableObjectState) {}

  private async update(
    action: "acquire" | "release" | "expire",
    lease?: string,
    max = 1,
    duration = 0,
    dailyMax?: number,
  ) {
    return this.state.storage.transaction(async (transaction) => {
      const now = Date.now();
      const leases = (await transaction.get<Leases>("leases")) ?? {};
      for (const [id, expiry] of Object.entries(leases)) if (expiry <= now) delete leases[id];
      const day = Math.floor(now / dayMs);
      let daily = await transaction.get<{ day: number; count: number }>("daily");
      if (daily && daily.day !== day) {
        await transaction.delete("daily");
        daily = undefined;
      }
      let result: "accepted" | "concurrency" | "quota" = "accepted";
      if (action === "acquire" && lease) {
        if (Object.keys(leases).length >= max) result = "concurrency";
        else if (dailyMax !== undefined && (daily?.count ?? 0) >= dailyMax) result = "quota";
        else {
          leases[lease] = now + duration + graceMs;
          if (dailyMax !== undefined) {
            daily = { day, count: (daily?.count ?? 0) + 1 };
            await transaction.put("daily", daily);
          }
        }
      } else if (action === "release" && lease) delete leases[lease];
      const expiries = Object.values(leases);
      if (daily) expiries.push((day + 1) * dayMs);
      if (expiries.length) {
        await transaction.put("leases", leases);
        await transaction.setAlarm(Math.min(...expiries));
      } else {
        await transaction.delete("leases");
        await transaction.deleteAlarm();
      }
      return result;
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const path = new URL(request.url).pathname;
      const lease = request.headers.get("Lease");
      if (!lease || !/^[a-zA-Z0-9-]{1,64}$/.test(lease)) return new Response(null, { status: 400 });
      if (path === "/release") {
        await this.update("release", lease);
        return new Response(null, { status: 204 });
      }
      const deployment = path === "/acquire-deployment";
      if (path !== "/acquire" && !deployment) return new Response(null, { status: 404 });
      const max = Number(request.headers.get("Limit"));
      const duration = Number(request.headers.get("Duration"));
      const dailyMax = deployment ? Number(request.headers.get("Daily-Limit")) : undefined;
      if (
        !Number.isSafeInteger(max) ||
        max < 1 ||
        max > (deployment ? 128 : 8) ||
        (deployment && (!Number.isSafeInteger(dailyMax) || dailyMax! < 1 || dailyMax! > 100_000)) ||
        !Number.isSafeInteger(duration) ||
        duration < 20 ||
        duration > 600_000
      )
        return new Response(null, { status: 400 });
      const result = await this.update("acquire", lease, max, duration, dailyMax);
      return new Response(null, {
        status: result === "accepted" ? 201 : 429,
        headers: result === "quota" ? { "X-Admission-Error": "quota" } : {},
      });
    } catch {
      return new Response(null, { status: 503 });
    }
  }

  async alarm() {
    await this.update("expire");
  }
}

export async function acquire(env: Env, identity: string): Promise<() => Promise<void>> {
  const bound = limits(env);
  const namespace = env.RELAY_ADMISSION;
  if (!namespace) throw new GatewayError("admission", 503);
  const deployment = deploymentLimits(env);
  const callerRelease = await reserve(namespace, identity, bound.concurrent, bound.totalMs);
  if (!deployment) return callerRelease;
  try {
    const deploymentRelease = await reserve(
      namespace,
      "deployment-v1",
      deployment.concurrent,
      bound.totalMs,
      deployment.daily,
    );
    return async () => {
      await Promise.all([callerRelease(), deploymentRelease()]);
    };
  } catch (error) {
    await callerRelease();
    throw error;
  }
}

async function reserve(
  namespace: DurableObjectNamespace,
  identity: string,
  concurrent: number,
  duration: number,
  daily?: number,
): Promise<() => Promise<void>> {
  const stub = namespace.get(namespace.idFromName(identity));
  const lease = crypto.randomUUID();
  let response: Response;
  try {
    response = await stub.fetch(`https://admission/${daily === undefined ? "acquire" : "acquire-deployment"}`, {
      method: "POST",
      headers: {
        Lease: lease,
        Limit: String(concurrent),
        Duration: String(duration),
        ...(daily === undefined ? {} : { "Daily-Limit": String(daily) }),
      },
    });
  } catch {
    throw new GatewayError("admission", 503);
  }
  if (response.status === 429) {
    if (response.headers.get("X-Admission-Error") === "quota") throw new GatewayError("quota", 429);
    throw new GatewayError("concurrency", 429, 30);
  }
  if (response.status !== 201) throw new GatewayError("admission", 503);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    // Failure stays bounded by persisted expiry; never retry or reopen the relay.
    try {
      await stub.fetch("https://admission/release", { method: "POST", headers: { Lease: lease } });
    } catch {
      /* The coordinator's alarm reclaims an abandoned lease. */
    }
  };
}