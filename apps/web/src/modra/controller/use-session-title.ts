import { useEffect, useState } from "react";
import { generateSessionTitle } from "@open-3d/ai";
import { loadAIProviderSettings } from "@open-3d/ai/settings";
import { ModraRuntime } from "@open-3d/ai/runtime";
import type { ModraTransport } from "@open-3d/ai/transport";
import { DurableModraSession } from "./durable-session";

/** Observe fresh first replies only; opening history never incurs a provider request. */
export function useSessionTitle(
  runtime: ModraRuntime | DurableModraSession,
  ready: boolean,
  readOnly: boolean,
  settingsRevision: number,
  sharedTransport: ModraTransport,
) {
  const [generated, setGenerated] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    if (!ready || readOnly) return;
    const initial = runtime.getSnapshot();
    // A restored completed/failed first round must not be summarized again.
    const initialAssistant = initial.messages.find((message) => message.role === "assistant");
    if (initialAssistant && initial.runs.find((run) => run.id === initialAssistant.runId)?.outcome) return;
    const abort = new AbortController();
    let attempted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (attempted || abort.signal.aborted) return;
      const state = runtime.getSnapshot();
      const first = state.messages.find((message) => message.role === "user");
      const reply = state.messages.find((message) => message.role === "assistant");
      if (!first || !reply || state.runs.find((run) => run.id === reply.runId)?.outcome !== "completed") return;
      attempted = true;
      if (runtime instanceof DurableModraSession && runtime.record.titleSource === "manual") return;
      const settings = loadAIProviderSettings();
      if (!settings) return;
      const fingerprint = JSON.stringify(settings);
      const assertCurrent = async () => {
        abort.signal.throwIfAborted();
        if (JSON.stringify(loadAIProviderSettings()) !== fingerprint) throw new Error("Settings changed");
        if (runtime instanceof DurableModraSession) await runtime.assertWritable();
        abort.signal.throwIfAborted();
        if (JSON.stringify(loadAIProviderSettings()) !== fingerprint) throw new Error("Settings changed");
      };
      const transport = sharedTransport.forRun(assertCurrent);
      timer = setTimeout(() => abort.abort(), 15_000);
      void generateSessionTitle({
        settings,
        fetch: transport.fetch,
        signal: abort.signal,
        prompt: first.text,
        reply: reply.text,
      })
        .then(async (title) => {
          await assertCurrent();
          if (runtime instanceof DurableModraSession) await runtime.summarizeTitle(title);
          if (!abort.signal.aborted) setGenerated({ id: state.id, title });
        })
        .catch(() => {
          /* The provisional title remains valid if naming is unavailable. */
        })
        .finally(() => clearTimeout(timer));
    };
    const unsubscribe = runtime.subscribe(() => {
      try {
        check();
      } catch {
        /* Optional metadata must never interrupt modeling. */
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
      abort.abort();
    };
  }, [runtime, ready, readOnly, settingsRevision, sharedTransport]);
  return generated?.id === runtime.getSnapshot().id ? generated.title : undefined;
}