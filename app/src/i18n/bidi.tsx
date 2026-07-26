import React from 'react';

export interface BidiProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
  as?: React.ElementType;
  className?: string;
}

export const UserText: React.FC<BidiProps> = ({ children, as: Component = 'span', className = '', ...props }) => {
  return (
    <bdi className={className} {...props}>
      {children}
    </bdi>
  );
};

export const TechnicalText: React.FC<BidiProps> = ({ children, as: Component = 'span', className = '', style, ...props }) => {
  return (
    <Component
      dir="ltr"
      className={className}
      style={{ unicodeBidi: 'isolate', ...style }}
      {...props}
    >
      {children}
    </Component>
  );
};
