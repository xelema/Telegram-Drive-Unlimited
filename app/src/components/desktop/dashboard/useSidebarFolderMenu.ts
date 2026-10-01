import { useCallback, useEffect, useRef, useState } from 'react';

interface MenuPosition {
  x: number;
  y: number;
}

export function useSidebarFolderMenu(enabled: boolean) {
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const openFromTrigger = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuPosition({ x: rect.left - 200, y: rect.bottom + 4 });
  }, []);

  const openFromContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (enabled) setMenuPosition({ x: event.clientX, y: event.clientY });
  }, [enabled]);

  const runAndClose = useCallback((action?: () => void) => {
    setMenuPosition(null);
    action?.();
  }, []);

  useEffect(() => {
    if (!menuPosition) return;
    const closeOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setMenuPosition(null);
    };
    window.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('contextmenu', closeOutside, true);
    return () => {
      window.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('contextmenu', closeOutside, true);
    };
  }, [menuPosition]);

  useEffect(() => {
    if (!menuPosition || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    let x = menuPosition.x;
    let y = menuPosition.y;
    if (x + rect.width > window.innerWidth) x -= rect.width;
    if (y + rect.height > window.innerHeight) y -= rect.height;
    if (x !== menuPosition.x || y !== menuPosition.y) setMenuPosition({ x, y });
  }, [menuPosition]);

  return {
    menuPosition,
    menuRef,
    triggerRef,
    openFromTrigger,
    openFromContextMenu,
    runAndClose,
  };
}
