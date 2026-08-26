import { Loader2, MoreHorizontal } from 'lucide-react';
import React, { memo, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Dropdown, DropdownContent, DropdownTrigger } from '../ui/dropdown';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

/**
 * zellij-only panel vocabulary. The panel used to be a copy of the tmux row —
 * same terminal glyph, same strip of five unlabeled circles — which read as
 * "tmux again" and left no room for the session name in a narrow side panel.
 *
 * zellij is named after *zellige*, Moroccan mosaic tilework, so the panel is
 * built around a four-tile mark, one primary action, and a labelled overflow
 * menu for everything else. The tmux panel keeps the shared SystemPanelUi row.
 */

export type ZellijTileTone = 'attached' | 'idle' | 'exited';

export const ZellijMosaicGlyph = memo(function ZellijMosaicGlyph({
  size = 12,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <rect x="0.5" y="0.5" width="4.6" height="4.6" rx="1.2" />
      <rect x="6.9" y="0.5" width="4.6" height="4.6" rx="1.2" opacity="0.55" />
      <rect x="0.5" y="6.9" width="4.6" height="4.6" rx="1.2" opacity="0.55" />
      <rect x="6.9" y="6.9" width="4.6" height="4.6" rx="1.2" />
    </svg>
  );
});

/** Session avatar: the mosaic mark tinted by session state. */
export const ZellijSessionTile = memo(function ZellijSessionTile({
  tone,
}: {
  tone: ZellijTileTone;
}) {
  return (
    <span
      className={cn(
        'grid h-7 w-7 shrink-0 place-items-center rounded-lg ring-1 transition-colors',
        tone === 'attached' && 'bg-emerald-500/15 text-emerald-600 ring-emerald-500/40 dark:text-emerald-400',
        tone === 'idle' && 'bg-primary/10 text-primary ring-primary/25',
        tone === 'exited' && 'bg-muted/70 text-muted-foreground/70 ring-border/60',
      )}
    >
      <ZellijMosaicGlyph size={13} />
    </span>
  );
});

/** Emerald dot + label used inline in the row subtitle. */
export const ZellijStateDot = memo(function ZellijStateDot({
  tone,
  label,
}: {
  tone: ZellijTileTone;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          tone === 'attached' && 'bg-emerald-500 dark:bg-emerald-400',
          tone === 'idle' && 'bg-primary/60',
          tone === 'exited' && 'bg-muted-foreground/50',
        )}
      />
      {label}
    </span>
  );
});

/**
 * The one action a session row is really for. Filled rather than another
 * ghost circle, so it reads as the row's primary affordance at a glance.
 */
export const ZellijPrimaryAction = memo(function ZellijPrimaryAction({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[10px] font-medium',
        'bg-primary text-primary-foreground shadow-sm transition-colors',
        'hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        'disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
});

export type ZellijMenuAction = {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  busy?: boolean;
};

/**
 * Labelled overflow for the secondary actions. Five unlabeled circles per row
 * did not survive a narrow side panel; a menu keeps the row readable and says
 * out loud what each action does.
 */
export const ZellijActionMenu = memo(function ZellijActionMenu({
  label,
  actions,
  disabled,
  busy,
}: {
  label: string;
  actions: ZellijMenuAction[];
  disabled?: boolean;
  /** An action from this menu is in flight; the trigger stands in for its progress. */
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (actions.length === 0) return null;

  return (
    <Dropdown open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <DropdownTrigger asChild>
              <button
                type="button"
                aria-label={label}
                disabled={disabled || busy}
                className={cn(
                  'grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors',
                  'hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
                  open && 'bg-muted text-foreground',
                )}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={14} />}
              </button>
            </DropdownTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownContent align="end" className="min-w-[160px] p-1">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            disabled={action.busy}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              action.onSelect();
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors',
              'disabled:pointer-events-none disabled:opacity-50',
              action.destructive
                ? 'text-destructive hover:bg-destructive/10'
                : 'text-foreground hover:bg-muted/70',
            )}
          >
            <span className="grid h-3.5 w-3.5 shrink-0 place-items-center opacity-80">
              {action.busy ? <Loader2 size={12} className="animate-spin" /> : action.icon}
            </span>
            <span className="truncate">{action.label}</span>
          </button>
        ))}
      </DropdownContent>
    </Dropdown>
  );
});

/** Tab chip inside an expanded session — a mosaic tile with its index. */
export const ZellijTabChip = memo(function ZellijTabChip({
  index,
}: {
  index: number;
}) {
  return (
    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-muted/70 text-[9px] font-medium tabular-nums text-muted-foreground ring-1 ring-border/50">
      {index}
    </span>
  );
});
