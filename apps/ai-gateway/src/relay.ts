import { GatewayError, limits, type Env } from "./contracts";
import { protocolFrom, target, upstreamHeaders } from "./policy";

export function boundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
  onError?: (error: unknown) => void,
  activity?: { progress(): void; complete(): void },
) {
  const reader = body.getReader();
  let bytes = 0;
  let settled = false;
  let onAbort: () => void;
  const cleanup = () => signal?.removeEventListener("abort", onAbort);
  const cancelSource = (reason: unknown) => {
    void reader.cancel(reason).catch(() => undefined);
  };
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, error: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    controller.error(error);
    // Native fetch may turn a failed upload into EOF; retain the cause outside the stream.
    onError?.(error);
    cancelSource(error);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => fail(controller, signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    },
    async pull(controller) {
      if (settled) return;
      try {
        const chunk = await reader.read();
        if (settled) return;
        if (chunk.done) {
          settled = true;
          cleanup();
          activity?.complete();
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new GatewayError("request-size", 413);
        if (chunk.value.byteLength) activity?.progress();
        controller.enqueue(chunk.value);
      } catch (error) {
        fail(controller, error);
      }
    },
    cancel(reason) {
      settled = true;
      cleanup();
      cancelSource(reason);
    },
  });
}

export async function relay(
  request: Request,
  env: Env,
  dispatch: typeof fetch,
  release: () => Promise<void>,
): Promise<Response> {
  const protocol = protocolFrom(request);
  const url = target(request, protocol);
  const headers = upstreamHeaders(request, protocol);
  const bound = limits(env);
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > bound.requestBytes))
    throw new GatewayError("request-size", 413);
  if (!request.body) throw new GatewayError("body", 400);

  const abort = new AbortController();
  let finished = false;
  let released: Promise<void> | undefined;
  let idle: ReturnType<typeof setTimeout>;
  let phase: "upload" | "response" | "stream" = "upload";
  const total = setTimeout(() => abort.abort(new GatewayError("duration", 504)), bound.totalMs);
  function resetIdle() {
    if (finished || abort.signal.aborted) return;
    clearTimeout(idle);
    const delay = phase === "upload" ? bound.uploadIdleMs : phase === "response" ? bound.responseStartMs : bound.idleMs;
    idle = setTimeout(() => abort.abort(new GatewayError("timeout", 504)), delay);
  }
  const awaitResponse = () => {
    if (phase !== "upload" || abort.signal.aborted) return;
    phase = "response";
    resetIdle();
  };
  const finish = () => {
    finished = true;
    clearTimeout(total);
    clearTimeout(idle);
    request.signal.removeEventListener("abort", cancel);
    return (released ??= release());
  };
  const cancel = () => abort.abort(new GatewayError("cancelled", 499));
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  resetIdle();
  let upstream: Response;
  try {
    abort.signal.throwIfAborted();
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      duplex: "half",
      headers,
      body: boundedBody(request.body, bound.requestBytes, abort.signal, (error) => abort.abort(error), {
        progress() {
          if (phase === "upload" && !abort.signal.aborted) resetIdle();
        },
        complete: awaitResponse,
      }),
      signal: abort.signal,
      redirect: "manual",
    };
    const upstreamRequest = new Request(url, init);
    upstream = await dispatch(upstreamRequest);
    if (abort.signal.aborted) {
      void upstream.body?.cancel().catch(() => undefined);
      abort.signal.throwIfAborted();
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      throw new GatewayError("redirect", 403);
    }
  } catch (error) {
    abort.abort(error);
    await finish();
    throw abort.signal.reason instanceof GatewayError
      ? abort.signal.reason
      : new GatewayError("upstream-unavailable", 502);
  }

  const responseHeaders = new Headers({ "Cache-Control": "no-store", "X-Open-3D-Error": "upstream" });
  const type = upstream.headers.get("Content-Type");
  responseHeaders.set("Content-Type", type?.startsWith("text/event-stream") ? "text/event-stream" : "application/json");
  const retry = upstream.headers.get("Retry-After");
  if (retry) {
    const seconds = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
    if (Number.isFinite(seconds))
      responseHeaders.set("Retry-After", String(Math.min(60, Math.max(0, Math.ceil(seconds)))));
  }
  if (!upstream.body) {
    await finish();
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }
  const reader = upstream.body.getReader();
  const onAbort = () => {
    void reader.cancel(abort.signal.reason).catch(() => undefined);
    void finish();
  };
  abort.signal.addEventListener("abort", onAbort, { once: true });
  if (abort.signal.aborted) onAbort();
  // Some providers send headers before consuming the upload; headers are not a response chunk.
  awaitResponse();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          abort.signal.throwIfAborted();
          const chunk = await reader.read();
          abort.signal.throwIfAborted();
          if (chunk.done) {
            abort.signal.removeEventListener("abort", onAbort);
            await finish();
            controller.close();
          } else {
            if (chunk.value.byteLength) {
              phase = "stream";
              resetIdle();
            }
            controller.enqueue(chunk.value);
          }
        } catch {
          abort.abort(new GatewayError("stream", 502));
          await reader.cancel().catch(() => undefined);
          await finish();
          controller.error(new GatewayError("stream", 502));
        }
      },
      async cancel() {
        abort.abort(new GatewayError("cancelled", 499));
        await reader.cancel().catch(() => undefined);
        await finish();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}