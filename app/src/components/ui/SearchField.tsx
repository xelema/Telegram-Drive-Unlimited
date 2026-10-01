import { forwardRef, type InputHTMLAttributes } from 'react';
import { Search } from 'lucide-react';
import { cx } from './cx';

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
