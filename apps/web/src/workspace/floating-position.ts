export interface FloatingPosition {
  x: number;
  y: number;
}

export function clampFloatingPosition(
  position: FloatingPosition,
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  margin = 16,
): FloatingPosition {
  const minX = Math.min(margin, Math.max(0, viewport.width - size.width));
  const minY = Math.min(margin, Math.max(0, viewport.height - size.height));
  return {
    x: Math.min(Math.max(minX, position.x), Math.max(minX, viewport.width - size.width - margin)),
    y: Math.min(Math.max(minY, position.y), Math.max(minY, viewport.height - size.height - margin)),
  };
}