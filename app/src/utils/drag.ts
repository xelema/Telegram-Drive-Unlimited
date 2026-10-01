export function createDragGhost(name: string, isFolder?: boolean, count?: number): HTMLElement {
  const ghost = document.createElement('div');
  ghost.style.position = 'fixed';
  ghost.style.left = '-9999px';
  ghost.style.top = '-9999px';
  ghost.style.pointerEvents = 'none';
  ghost.style.zIndex = '9999';
  ghost.style.display = 'flex';
  ghost.style.alignItems = 'center';
  ghost.style.gap = '8px';
  ghost.style.padding = '8px 12px';
  ghost.style.background = 'rgba(30,30,35,0.95)';
  ghost.style.border = '1px solid rgba(0,136,204,0.4)';
  ghost.style.borderRadius = '8px';
  ghost.style.boxShadow = '0 4px 16px rgba(0,0,0,0.3)';
  ghost.style.maxWidth = '220px';

  const icon = document.createElement('span');
  icon.style.flexShrink = '0';
  icon.style.fontSize = '16px';
  icon.textContent = isFolder ? '📁' : '📄';
  ghost.appendChild(icon);

  const label = document.createElement('span');
  label.style.fontSize = '12px';
  label.style.fontWeight = '500';
  label.style.color = '#e4e4e7';
  label.style.whiteSpace = 'nowrap';
  label.style.overflow = 'hidden';
  label.style.textOverflow = 'ellipsis';
  label.textContent = name;
  ghost.appendChild(label);

  if (count && count > 1) {
    const badge = document.createElement('span');
    badge.style.flexShrink = '0';
    badge.style.marginLeft = '2px';
    badge.style.padding = '2px 6px';
    badge.style.background = 'rgba(0,136,204,0.85)';
    badge.style.color = '#fff';
    badge.style.fontSize = '10px';
    badge.style.fontWeight = '700';
    badge.style.borderRadius = '10px';
    badge.style.lineHeight = '1.2';
    badge.style.minWidth = '18px';
    badge.style.textAlign = 'center';
    badge.textContent = String(count);
    ghost.appendChild(badge);
  }

  document.body.appendChild(ghost);
  return ghost;
}
