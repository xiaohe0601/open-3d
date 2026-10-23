import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return <DialogPrimitive.Backdrop className={className} {...props} />;
}

function DialogContent({
  className,
  showBackdrop = true,
  backdropClassName,
  keepMounted = false,
  ...props
}: DialogPrimitive.Popup.Props & { showBackdrop?: boolean; keepMounted?: boolean; backdropClassName?: string }) {
  return (
    <DialogPortal keepMounted={keepMounted}>
      {showBackdrop && (
        <DialogBackdrop
          forceRender
          data-slot="dialog-backdrop"
          className={cn("fixed inset-0 z-[1000] bg-scrim", backdropClassName)}
        />
      )}
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "max-h-[calc(100dvh-32px)] overflow-y-auto overscroll-contain",
          showBackdrop &&
            "fixed top-1/2 left-1/2 z-[1001] w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-sheet p-5 text-foreground shadow-lg",
          className,
        )}
        {...props}
      />
    </DialogPortal>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("m-0 text-base font-semibold leading-6", className)}
      {...props}
    />
  );
}

function DialogHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex min-h-16 shrink-0 items-center justify-between gap-3 px-5 py-4", className)}
    >
      {children}
    </div>
  );
}
const DialogDescription = DialogPrimitive.Description;

export {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogPortal,
  DialogTitle,
  DialogHeader,
  DialogTrigger,
};