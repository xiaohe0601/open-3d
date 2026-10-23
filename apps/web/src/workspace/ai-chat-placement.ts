export type AIChatPlacement = "top-end" | "bottom-end" | "left-end" | "right-end";

export const AI_CHAT_LAYOUT = { width: 420, height: 600, gap: 12, inset: 16 } as const;

const placementHysteresis = 32;

export function selectAIChatPlacement(
  anchor: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  current: AIChatPlacement | null,
): AIChatPlacement {
  const { width, height, gap, inset } = AI_CHAT_LAYOUT;
  const chatWidth = Math.max(0, Math.min(width, viewport.width - inset * 2));
  const chatHeight = Math.max(0, Math.min(height, viewport.height - inset * 2));
  const space = {
    "top-end": anchor.y - inset - gap,
    "bottom-end": viewport.height - anchor.y - anchor.height - inset - gap,
    "left-end": anchor.x - inset - gap,
    "right-end": viewport.width - anchor.x - anchor.width - inset - gap,
  };

  function visibleHeight(placement: AIChatPlacement) {
    if (placement === "top-end" || placement === "bottom-end") {
      return Math.max(0, Math.min(chatHeight, space[placement]));
    }
    // Enter a side with spare room, but keep it until the full reading width no longer fits.
    const reserve = current === placement ? 0 : placementHysteresis;
    return space[placement] >= chatWidth + reserve ? chatHeight : -1;
  }

  // Score the intended size, never the resized popup: size middleware must not feed back into placement.
  const placements: AIChatPlacement[] = ["top-end", "bottom-end", "left-end", "right-end"];
  const best = placements.reduce((winner, candidate) =>
    visibleHeight(candidate) > visibleHeight(winner) ? candidate : winner,
  );
  if (current && visibleHeight(current) >= 0 && visibleHeight(best) - visibleHeight(current) <= placementHysteresis) {
    return current;
  }
  return best;
}