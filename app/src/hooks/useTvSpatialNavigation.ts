import { useEffect } from 'react';

type Direction = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

function isVisible(element: HTMLElement, requireViewport = true): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]') || getComputedStyle(element).visibility === 'hidden') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && (!requireViewport || (
    rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
  ));
}

function usesNativeArrow(element: HTMLElement, key: string): boolean {
  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || element.isContentEditable) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  if (['text','password','search','email','url','tel'].includes(element.type)) return key === 'ArrowLeft' || key === 'ArrowRight';
  return ['number','range','date','datetime-local','month','week','time','radio'].includes(element.type);
}

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
    let navigationField: HTMLElement | null = null;
    let escapeConsumed = false;
    const onFocusOut = () => { navigationField = null; };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Escape') escapeConsumed = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.repeat && escapeConsumed) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (!event.repeat) escapeConsumed = false;
      }
      const modal = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"]'))
        .filter(element => isVisible(element)).pop();
      const focused = document.activeElement;
      const nativeField = focused instanceof HTMLElement && (!modal || modal.contains(focused)) && usesNativeArrow(focused,'ArrowLeft');
      // Back leaves native editing first; another Back keeps the normal dialog
      // behavior. Enter resumes editing without submitting the surrounding form.
      if (nativeField && event.key === 'Escape' && navigationField !== focused) {
        navigationField = focused;
        escapeConsumed = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (nativeField && event.key === 'Enter' && navigationField === focused) {
        navigationField = null;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      if (focused instanceof HTMLElement && navigationField !== focused && (!modal || modal.contains(focused)) && usesNativeArrow(focused,event.key)) {
        if (modal) event.stopPropagation();
        return;
      }
      if (navigationField === focused) event.preventDefault();
      const focusable = Array.from((modal ?? document).querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(element => isVisible(element,false));
      if (modal) {
        // A remote must not move or dispatch navigation to the page behind a dialog.
        event.preventDefault();
        event.stopPropagation();
      }
      if (focusable.length === 0) {
        if (modal && !modal.contains(document.activeElement)) {
          if (!modal.hasAttribute('tabindex')) modal.tabIndex = -1;
          modal.focus();
        }
        return;
      }
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
    window.addEventListener('focusout', onFocusOut, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('focusout', onFocusOut, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [enabled]);
}
