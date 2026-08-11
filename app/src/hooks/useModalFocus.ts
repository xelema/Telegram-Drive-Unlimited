import { RefObject, useEffect, useRef } from 'react';

const FOCUSABLE = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Gives desktop dialogs predictable keyboard behaviour: initial focus,
 * focus trapping, Escape-to-close, and restoration to the invoking control.
 */
export function useModalFocus(
    containerRef: RefObject<HTMLElement | null>,
    onClose: () => void,
    enabled = true,
) {
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    useEffect(() => {
        if (!enabled) return;
        const previouslyFocused = document.activeElement as HTMLElement | null;
        const container = containerRef.current;
        if (!container) return;

        const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
        const preferred = container.querySelector<HTMLElement>('[data-modal-autofocus]');
        (preferred ?? focusable[0] ?? container).focus();

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab') return;

            const current = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
            if (current.length === 0) {
                event.preventDefault();
                container.focus();
                return;
            }
            const first = current[0];
            const last = current[current.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
            previouslyFocused?.focus?.();
        };
    }, [containerRef, enabled]);
}
