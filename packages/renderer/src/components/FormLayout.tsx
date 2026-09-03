import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/utils.js';

export function FormShell({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div className={cn('form-shell', className)} {...props}>
      {children}
    </div>
  );
}

export function FormSection({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <section className={cn('form-section', className)} {...props}>
      {children}
    </section>
  );
}

export function FormActions({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div className={cn('form-actions', className)} {...props}>
      {children as ReactNode}
    </div>
  );
}
