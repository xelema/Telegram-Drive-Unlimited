import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export interface ActionItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}

interface ActionPopoverProps {
  actions: ActionItem[];
  onClose: () => void;
  title?: string;
}

/**
 * A bottom-sheet-style action popover for mobile, replacing swipe-to-reveal.
 * Tapping a file's ⋮ button opens this popover with contextual actions.
 */
export function ActionPopover({ actions, onClose, title }: ActionPopoverProps) {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      <div
        className="w-full max-w-lg bg-[#1c1c1e] border border-white/10 rounded-t-3xl p-5 pb-8 shadow-2xl animate-in slide-in-from-bottom duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="flex justify-center mb-4">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        {title && (
          <h3 className="text-sm font-bold text-white mb-4 px-1 truncate">{title}</h3>
        )}

        <div className="space-y-1.5">
          {actions.map((action, i) => (
            <button
              key={i}
              onClick={() => {
                action.onClick();
                onClose();
              }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-semibold transition-all duration-200 active:scale-[0.98] ${
                action.destructive
                  ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20'
                  : 'bg-white/5 text-white hover:bg-white/10 border border-white/5'
              }`}
            >
              {action.icon && <span className="flex-shrink-0">{action.icon}</span>}
              {action.label}
            </button>
          ))}
        </div>

        {/* Cancel button */}
        <button
          onClick={onClose}
          className="w-full mt-3 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-sm font-semibold bg-white/5 text-telegram-subtext hover:bg-white/10 border border-white/5 transition-all duration-200 active:scale-[0.98]"
        >
          <X className="w-4 h-4" />
          Cancel
        </button>
      </div>
    </div>
  );
}
