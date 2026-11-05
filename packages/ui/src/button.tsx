import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from './utils';

const buttonVariants = cva(
  'sazuz-button inline-flex shrink-0 items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60',
  {
    variants: {
      variant: {
        primary: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'border-border bg-card text-foreground hover:bg-muted',
        ghost: 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
      },
      size: {
        default: 'min-h-10 px-4 py-2',
        small: 'min-h-9 px-3 py-1.5',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
