import { useEffect } from 'react';

type Direction = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function findSpatialCandidate(
  current: DOMRect,
  candidates: Array<{ element: HTMLElement; rect: DOMRect }>,
  direction: Direction,
): HTMLElement | null {
  const currentX = current.left + current.width / 2;
  const currentY = current.top + current.height / 2;
  let best: { element: HTMLElement; score: number } | null = null;
  for (const candidate of candidates) {
    const x = candidate.rect.left + candidate.rect.width / 2;
    const y = candidate.rect.top + candidate.rect.height / 2;
    const dx = x - currentX;
    const dy = y - currentY;
    const primary = direction === 'ArrowRight' ? dx : direction === 'ArrowLeft' ? -dx : direction === 'ArrowDown' ? dy : -dy;
    if (primary <= 1) continue;
    const perpendicular = direction === 'ArrowLeft' || direction === 'ArrowRight' ? Math.abs(dy) : Math.abs(dx);
    const beamPenalty = perpendicular > primary ? perpendicular * 2 : perpendicular * 0.65;
    const score = primary + beamPenalty;
    if (!best || score < best.score) best = { element: candidate.element, score };
  }
  return best?.element ?? null;
}

export function useTvSpatialNavigation(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const focusable = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(element => {
          if (element.offsetParent === null || element.getAttribute('aria-hidden') === 'true') return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
            rect.top < window.innerHeight && rect.left < window.innerWidth;
        });
      if (focusable.length === 0) return;
      const active = document.activeElement instanceof HTMLElement && focusable.includes(document.activeElement)
        ? document.activeElement
        : null;
      if (!active) {
        event.preventDefault();
        focusable[0].focus();
        return;
      }
      const next = findSpatialCandidate(
        active.getBoundingClientRect(),
        focusable.filter(element => element !== active).map(element => ({ element, rect: element.getBoundingClientRect() })),
        event.key as Direction,
      );
      if (next) {
        event.preventDefault();
        next.focus({ preventScroll: false });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}
