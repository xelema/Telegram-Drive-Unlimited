import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { cx } from './cx';

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
