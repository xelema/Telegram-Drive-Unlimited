import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { Search } from 'lucide-react';

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

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

export interface SearchFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  containerClassName?: string;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { className, containerClassName, ...props },
  ref,
) {
  return (
    <label className={cx(
      'quiet-control flex h-8 items-center gap-2 border border-app-border bg-app-surface-sunken/45 px-2.5 text-app-text-secondary focus-within:border-app-accent/60 focus-within:bg-app-surface-sunken/60 focus-within:text-app-text',
      containerClassName,
    )}>
      <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        className={cx(
          'min-w-0 flex-1 bg-transparent text-ui text-app-text outline-none placeholder:text-app-text-tertiary',
          className,
        )}
        {...props}
      />
    </label>
  );
});

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  raised?: boolean;
}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { className, raised = false, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx(raised ? 'quiet-raised' : 'quiet-surface', className)}
      {...props}
    />
  );
});

export function MenuPanel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="menu" className={cx('quiet-menu p-1', className)} {...props} />;
}

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: 'default' | 'danger';
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { className, tone = 'default', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('quiet-menu-item', tone === 'danger' && 'text-app-danger', className)}
      {...props}
    />
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, type = 'text', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cx(
        'quiet-control h-8 w-full border border-app-border bg-app-surface-sunken/45 px-2.5 text-ui text-app-text outline-none placeholder:text-app-text-tertiary focus:border-app-accent/60 disabled:opacity-45',
        className,
      )}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cx(
        'quiet-control h-8 border border-app-border bg-app-surface-sunken/45 px-2.5 text-ui text-app-text outline-none focus:border-app-accent/60 disabled:opacity-45',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});

interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  touch?: boolean;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, label, touch = false, className, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        'relative shrink-0 rounded-control border border-transparent bg-transparent disabled:opacity-45',
        touch ? 'h-11 w-11' : 'h-[22px] w-10',
        className,
      )}
      {...props}
    >
      <span className={cx(
        'absolute h-[22px] w-10 rounded-full border transition-colors',
        touch ? 'start-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rtl:translate-x-1/2' : 'inset-0',
        checked ? 'border-app-accent bg-app-accent' : 'border-app-border-strong bg-app-surface-sunken',
      )}>
        <span className={cx(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ltr:left-0.5 rtl:right-0.5',
          checked ? 'ltr:translate-x-[18px] rtl:-translate-x-[18px]' : 'translate-x-0',
        )} />
      </span>
    </button>
  );
});

interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: Array<SegmentedOption<T>>;
  label: string;
  className?: string;
}

export function SegmentedControl<T extends string>({ value, onValueChange, options, label, className }: SegmentedControlProps<T>) {
  return (
    <div role="group" aria-label={label} className={cx('quiet-control inline-flex border border-app-border bg-app-surface-sunken/45 p-0.5', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onValueChange(option.value)}
          className={cx(
            'quiet-control min-h-[28px] px-2.5 text-badge font-medium',
            option.value === value ? 'bg-app-surface-raised text-app-text shadow-sm' : 'text-app-text-secondary hover:text-app-text',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}

const badgeTones = {
  neutral: 'border-app-border bg-app-hover text-app-text-secondary',
  accent: 'border-app-accent/20 bg-app-selected text-app-accent',
  success: 'border-app-success/20 bg-app-success/10 text-app-success',
  warning: 'border-app-warning/20 bg-app-warning/10 text-app-warning',
  danger: 'border-app-danger/20 bg-app-danger/10 text-app-danger',
};

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return <span className={cx('inline-flex items-center rounded-full border px-2 py-0.5 text-badge font-medium', badgeTones[tone], className)} {...props} />;
}

export function StatusDot({ tone = 'neutral', label }: { tone?: 'neutral' | 'success' | 'warning' | 'danger'; label: string }) {
  const tones = { neutral: 'bg-app-text-tertiary', success: 'bg-app-success', warning: 'bg-app-warning', danger: 'bg-app-danger' };
  return <span className={cx('inline-block h-2 w-2 rounded-full', tones[tone])} role="img" aria-label={label} title={label} />;
}

export function Progress({ value, label, className }: { value: number; label: string; className?: string }) {
  const bounded = Math.min(100, Math.max(0, value));
  return (
    <div className={cx('h-1.5 overflow-hidden rounded-full bg-app-border', className)} role="progressbar" aria-label={label} aria-valuenow={bounded} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-app-accent transition-[width]" style={{ width: `${bounded}%` }} />
    </div>
  );
}

export function Divider({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('h-px bg-app-border-subtle', className)} {...props} />;
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cx('animate-pulse rounded-control bg-app-hover', className)} {...props} />;
}
