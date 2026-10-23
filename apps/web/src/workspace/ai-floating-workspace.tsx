import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
} from "react";
import { autoUpdate, offset, shift, size, useFloating } from "@floating-ui/react-dom";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Bot, X } from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { AIProviderSettingsDialog } from "./ai-provider-settings-dialog";
import { clampFloatingPosition, type FloatingPosition } from "./floating-position";
import { AI_CHAT_LAYOUT, selectAIChatPlacement, type AIChatPlacement } from "./ai-chat-placement";

const AIConversationPanel = lazy(() =>
  import("./ai-conversation-panel").then((module) => ({ default: memo(module.AIConversationPanel) })),
);

type AIFloatingWorkspaceProps = Pick<
  ComponentProps<typeof AIConversationPanel>,
  "document" | "onPreviewDocument" | "onAcceptProposal"
>;

function FloatingAITrigger({ onReferenceChange }: { onReferenceChange: (node: HTMLButtonElement | null) => void }) {
  const { t } = useTranslation("workspace");
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; origin: FloatingPosition } | null>(null);
  const dragged = useRef(false);
  const setButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      buttonRef.current = node;
      onReferenceChange(node);
    },
    [onReferenceChange],
  );

  function constrain(next: FloatingPosition) {
    const rect = buttonRef.current!.getBoundingClientRect();
    return clampFloatingPosition(next, { width: window.innerWidth, height: window.innerHeight }, rect);
  }

  useEffect(() => {
    const resize = () => {
      // Keep the responsive default until the user explicitly moves the launcher.
      setPosition((current) => (current ? constrain(current) : null));
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return createPortal(
    <DialogTrigger
      render={
        <Button
          ref={setButtonRef}
          size="icon"
          className="ai-floating-trigger fixed right-6 bottom-6 z-[901] size-11 touch-none cursor-grab rounded-full border border-border bg-primary p-0 text-primary-foreground shadow-md hover:bg-primary-hover active:cursor-grabbing max-[1000px]:bottom-36"
          style={position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined}
          aria-label={t("aiChat")}
          aria-describedby="ai-floating-instructions"
          title={t("dragAI")}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            const rect = event.currentTarget.getBoundingClientRect();
            dragged.current = false;
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              origin: { x: rect.x, y: rect.y },
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const session = drag.current;
            if (!session || session.id !== event.pointerId) return;
            const dx = event.clientX - session.x;
            const dy = event.clientY - session.y;
            if (!dragged.current && Math.hypot(dx, dy) < 5) return;
            dragged.current = true;
            setPosition(constrain({ x: session.origin.x + dx, y: session.origin.y + dy }));
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onClickCapture={(event) => {
            if (dragged.current && event.detail !== 0) {
              event.preventDefault();
              event.stopPropagation();
            }
            dragged.current = false;
          }}
          onKeyDown={(event) => {
            const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
            if (!delta) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const step = event.shiftKey ? 40 : 10;
            setPosition(constrain({ x: rect.x + delta[0] * step, y: rect.y + delta[1] * step }));
          }}
        >
          <Bot className="size-5" />
          <span id="ai-floating-instructions" className="sr-only">
            {t("dragAI")}
          </span>
        </Button>
      }
    />,
    globalThis.document.body,
  );
}

export function AIFloatingWorkspace(props: AIFloatingWorkspaceProps) {
  const { t } = useTranslation("workspace");
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const preferredPlacement = useRef<AIChatPlacement | null>(null);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const { refs, elements, floatingStyles, placement, isPositioned, update } = useFloating({
    open,
    placement: "top-end",
    strategy: "fixed",
    transform: false,
    middleware: [
      offset(AI_CHAT_LAYOUT.gap),
      {
        name: "stablePlacement",
        fn({ rects, elements: positioned, placement: computedPlacement }) {
          const viewport = positioned.floating.ownerDocument.documentElement;
          const next = selectAIChatPlacement(
            rects.reference,
            { width: viewport.clientWidth, height: viewport.clientHeight },
            preferredPlacement.current,
          );
          preferredPlacement.current = next;
          return computedPlacement === next ? {} : { reset: { placement: next } };
        },
      },
      shift({ padding: AI_CHAT_LAYOUT.inset }),
      size({
        padding: AI_CHAT_LAYOUT.inset,
        apply({ availableWidth, availableHeight, elements: positioned }) {
          Object.assign(positioned.floating.style, {
            width: `${Math.max(0, Math.min(AI_CHAT_LAYOUT.width, availableWidth))}px`,
            height: `${Math.max(0, Math.min(AI_CHAT_LAYOUT.height, availableHeight))}px`,
          });
        },
      }),
    ],
  });

  useEffect(() => {
    if (!open || !elements.reference || !elements.floating) return;
    // Track fixed-position launcher movement as well as viewport and content resizing.
    return autoUpdate(elements.reference, elements.floating, update, { animationFrame: true });
  }, [open, elements.reference, elements.floating, update]);

  const transformOrigin = {
    top: "bottom right",
    bottom: "top right",
    left: "right bottom",
    right: "left bottom",
  }[placement.split("-")[0]];

  return (
    <Dialog
      modal={false}
      disablePointerDismissal
      open={open}
      onOpenChange={(next) => {
        if (next) preferredPlacement.current = null;
        setOpen(next);
        if (next) setOpened(true);
      }}
    >
      <FloatingAITrigger onReferenceChange={refs.setReference} />
      {opened && (
        <DialogContent
          showBackdrop={false}
          keepMounted
          ref={refs.setFloating}
          data-testid="ai-floating-dialog"
          data-placement={placement}
          style={{ ...floatingStyles, transformOrigin, visibility: open && !isPositioned ? "hidden" : undefined }}
          className="ai-floating-dialog fixed z-[900] flex h-[min(600px,calc(100dvh-32px))] w-[min(420px,calc(100vw-32px))] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-sheet text-foreground shadow-xs transition-[opacity,scale] duration-180 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-closed:pointer-events-none motion-reduce:transition-none [&[hidden]]:hidden"
        >
          <div className="flex min-h-12 shrink-0 items-center justify-between border-b border-border px-4">
            <DialogTitle className="text-[15px] font-semibold">{t("aiChat")}</DialogTitle>
            <DialogDescription className="sr-only">{t("floatingAIDescription")}</DialogDescription>
            <DialogClose
              render={<Button variant="ghost" size="icon" className="size-11 text-muted" aria-label={t("closeAI")} />}
            >
              <X size={18} />
            </DialogClose>
          </div>
          <div className="ai-floating-content flex min-h-0 flex-1 p-3">
            <Suspense fallback={<p role="status">{t("loadingAI")}</p>}>
              <AIConversationPanel
                {...props}
                active={open}
                settingsRevision={settingsRevision}
                onOpenSettings={openSettings}
              />
            </Suspense>
          </div>
          <AIProviderSettingsDialog
            open={settingsOpen}
            onOpenChange={(next) => {
              setSettingsOpen(next);
              if (!next) setSettingsRevision((revision) => revision + 1);
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}