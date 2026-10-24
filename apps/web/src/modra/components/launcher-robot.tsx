export type ModraActivity = "idle" | "generating" | "completed" | "error";

/** Fixed-size robot; only its face moves, so dragging and hit targets stay stable. */
export function ModraRobot({ activity }: { activity: ModraActivity }) {
  return (
    <svg
      className="modra-robot size-6"
      data-activity={activity}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g className="modra-robot-head">
        <path d="M12 6V3m-1.5 0h3M5 11H3v5h2m14-5h2v5h-2" />
        <rect x="5" y="7" width="14" height="13" rx="4" />
        <g className="modra-robot-eyes">
          {activity === "completed" ? (
            <path d="m8 12 1-1 1 1m4 0 1-1 1 1" />
          ) : activity === "error" ? (
            <path d="m8 11 2 2m0-2-2 2m6-2 2 2m0-2-2 2" />
          ) : (
            <path d="M9 11v2m6-2v2" />
          )}
        </g>
        {activity === "error" ? (
          <path d="M10 17q2-2 4 0" />
        ) : activity === "completed" ? (
          <path d="M9 16q3 4 6 0" />
        ) : (
          <path className="modra-robot-mouth" d="M10 16h4" />
        )}
      </g>
    </svg>
  );
}