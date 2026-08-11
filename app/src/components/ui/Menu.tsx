import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes } from 'react';
import { cx } from './cx';

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
