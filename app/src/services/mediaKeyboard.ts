/** Leave editing, browser shortcuts, and focused control activation to their owner. */
export function shouldHandleMediaShortcut(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
    const target = event.target;
    if (!(target instanceof Element)) return true;
    if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return false;
    if (event.key === ' ' && target.closest('button, a[href], [role="button"], [role="checkbox"], [role="switch"]')) return false;
    return true;
}
