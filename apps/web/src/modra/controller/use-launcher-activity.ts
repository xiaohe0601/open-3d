import { useEffect, useLayoutEffect, useState } from "react";
import type { ModraActivity } from "../components/launcher-robot";
import { LauncherActivityController } from "./launcher-activity";

export function useLauncherActivity(open: boolean) {
  const [activity, setActivity] = useState<ModraActivity>("idle");
  const [controller] = useState(() => new LauncherActivityController(setActivity));
  const [reportActivity] = useState(() => (next: ModraActivity) => controller.report(next));
  useLayoutEffect(() => controller.setOpen(open), [controller, open]);
  useEffect(() => () => controller.dispose(), [controller]);
  return { activity, reportActivity };
}