import type { ModraActivity } from "../components/launcher-robot";

export const COMPLETION_ACKNOWLEDGEMENT_MS = 3000;

/** Keep unseen completion until opening; acknowledge visible completion after a short pause. */
export class LauncherActivityController {
  private open = false;
  private reported: ModraActivity = "idle";
  private displayed: ModraActivity = "idle";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;

  constructor(private readonly onChange: (activity: ModraActivity) => void) {}

  private show(activity: ModraActivity) {
    this.displayed = activity;
    this.onChange(activity);
  }

  dispose() {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  setOpen(open: boolean) {
    if (open === this.open) return;
    this.open = open;
    this.dispose();
    if (open && this.displayed === "completed") this.show("idle");
  }

  report(activity: ModraActivity) {
    if (activity === this.reported) return;
    this.reported = activity;
    this.dispose();
    this.show(activity);
    if (activity !== "completed" || !this.open) return;
    const revision = this.revision;
    this.timer = setTimeout(() => {
      // A prior operation must never acknowledge a newer operation's completion.
      if (revision === this.revision && this.open && this.displayed === "completed") {
        this.timer = undefined;
        this.show("idle");
      }
    }, COMPLETION_ACKNOWLEDGEMENT_MS);
  }
}