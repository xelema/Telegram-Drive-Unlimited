import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-app-accent text-app-accent-contrast hover:bg-app-accent-hover border-transparent',
  secondary: 'bg-app-surface-raised text-app-text border-app-border hover:border-app-border-strong',
  ghost: 'bg-transparent text-app-text-secondary border-transparent hover:text-app-text',
  danger: 'bg-app-danger/10 text-app-danger border-transparent hover:bg-app-danger/16',
};

const buttonSizes: Record<ButtonSize, string> = {
  xs: 'h-7 gap-1.5 px-2.5 text-badge',
  sm: 'h-[30px] gap-1.5 px-2.5 text-ui',
  md: 'h-8 gap-1.5 px-3 text-ui',
  lg: 'h-9 gap-2 px-3.5 text-ui',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', leadingIcon, trailingIcon, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'quiet-control inline-flex shrink-0 items-center justify-center border font-medium disabled:opacity-45',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});
