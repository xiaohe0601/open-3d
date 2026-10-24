import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import type { GatewayChallengeRequest } from "../controller/use-gateway-challenge";

interface Turnstile {
  render(
    this: void,
    element: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      size: "flexible";
      "response-field": false;
      callback(token: string): void;
      "error-callback"(): void;
      "expired-callback"(): void;
      "timeout-callback"(): void;
    },
  ): string;
  remove(this: void, id: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | undefined;
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = setTimeout(fail, 15_000);
    function fail() {
      clearTimeout(timeout);
      script.remove();
      loading = undefined;
      reject(new Error("Challenge unavailable"));
    }
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => {
      clearTimeout(timeout);
      if (window.turnstile) resolve(window.turnstile);
      else fail();
    };
    script.onerror = fail;
    document.head.append(script);
  });
  return loading;
}

function ChallengeWidget({ request, siteKey }: { request: GatewayChallengeRequest; siteKey: string | undefined }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!request) return;
    if (!siteKey) {
      request.cancel();
      return;
    }
    let disposed = false;
    let widget: string | undefined;
    let api: Turnstile | undefined;
    void loadTurnstile()
      .then((loaded) => {
        if (disposed || !container.current) return;
        api = loaded;
        widget = api.render(container.current, {
          sitekey: siteKey,
          action: "modra-relay",
          size: "flexible",
          "response-field": false,
          callback: (token) => {
            if (!disposed) request.complete(token);
          },
          "error-callback": () => {
            if (!disposed) request.cancel();
          },
          "expired-callback": () => {
            if (!disposed) request.cancel();
          },
          "timeout-callback": () => {
            if (!disposed) request.cancel();
          },
        });
      })
      .catch(() => {
        if (!disposed) request.cancel();
      });
    return () => {
      disposed = true;
      if (widget !== undefined) api?.remove(widget);
    };
  }, [request, siteKey]);
  return <div ref={container} className="min-h-16 min-w-0" />;
}

export function GatewayChallenge({
  request,
  siteKey,
}: {
  request: GatewayChallengeRequest | null;
  siteKey: string | undefined;
}) {
  const { t } = useTranslation("ai");
  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open) request?.cancel();
      }}
    >
      <DialogContent className="grid gap-4">
        <DialogTitle>{t("gatewayVerification")}</DialogTitle>
        <DialogDescription className="m-0 text-sm text-muted">{t("gatewayVerificationNotice")}</DialogDescription>
        {request && <ChallengeWidget request={request} siteKey={siteKey} />}
        <Button variant="outline" onClick={() => request?.cancel()}>
          {t("cancelRequest")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}