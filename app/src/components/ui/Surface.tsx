import { forwardRef, type HTMLAttributes } from 'react';
import { cx } from './cx';

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
