import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cx } from './cx';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  tone?: 'default' | 'danger';
}

const iconSizes = {
  xs: 'h-7 w-7',
  sm: 'h-[30px] w-[30px]',
  md: 'h-8 w-8',
  lg: 'h-9 w-9',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, label, size = 'md', tone = 'default', children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'quiet-control inline-flex shrink-0 items-center justify-center border border-transparent disabled:opacity-45',
        iconSizes[size],
        tone === 'danger'
          ? 'text-app-danger hover:bg-app-danger/10'
          : 'text-app-text-secondary hover:text-app-text',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
