import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from './utils';

const badgeVariants = cva(
  'sazuz-badge inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border px-2 py-1 text-xs font-medium leading-none',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        success: 'border-success/20 bg-success-soft text-success',
        warning: 'border-warning/20 bg-warning-soft text-warning',
        danger: 'border-danger/20 bg-danger-soft text-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
