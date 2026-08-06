export interface ViewportRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export function rectsIntersect(a: ViewportRect, b: ViewportRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** Clamp a drag translation so the original rectangle stays within the viewport. */
export function clampDragOffset(
  rect: Pick<ViewportRect, "left" | "top" | "width" | "height">,
  offset: { x: number; y: number },
  viewport: { width: number; height: number },
  margin = 8,
): { x: number; y: number } {
  const minX = margin - rect.left
  const maxX = viewport.width - margin - rect.width - rect.left
  const minY = margin - rect.top
  const maxY = viewport.height - margin - rect.height - rect.top
  return {
    x: Math.min(Math.max(offset.x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(offset.y, minY), Math.max(minY, maxY)),
  }
}
