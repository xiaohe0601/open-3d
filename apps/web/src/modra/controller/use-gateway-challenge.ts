import { useCallback, useEffect, useRef, useState } from "react";
import { GatewayTransportError } from "@open-3d/ai/transport";

export interface GatewayChallengeRequest {
  complete(token: string): void;
  cancel(): void;
}

export function useGatewayChallenge() {
  const [request, setRequest] = useState<GatewayChallengeRequest | null>(null);
  const pending = useRef<GatewayChallengeRequest | null>(null);
  const challenge = useCallback((signal?: AbortSignal | null): Promise<string> => {
    signal?.throwIfAborted();
    pending.current?.cancel();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (token?: string) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        pending.current = null;
        setRequest(null);
        if (token) resolve(token);
        else reject(signal?.aborted ? signal.reason : new GatewayTransportError("challenge"));
      };
      const abort = () => finish();
      const next = { complete: (token: string) => finish(token), cancel: abort };
      pending.current = next;
      signal?.addEventListener("abort", abort, { once: true });
      setRequest(next);
    });
  }, []);
  useEffect(() => () => pending.current?.cancel(), []);
  return { challenge, request };
}