import { cn } from '../../lib/utils';
import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import type { ComponentProps } from 'react';
import { memo } from 'react';
import { Streamdown } from 'streamdown';
import { createSafeCodeHighlighter } from './streamdownCodeHighlighter';

const safeCode = createSafeCodeHighlighter(code);
const streamdownPlugins = { cjk, code: safeCode };

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

/** Heavy markdown renderer — load via LazyMessageResponse, not the chat list critical path. */
export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        'size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        // Style the rendered markdown
        // Code: base styles (code-block overrides are in index.css)
        '[&_code]:text-[12px] [&_code]:font-mono',
        '[&_p_code]:px-[0.4em] [&_p_code]:py-[0.15em] [&_p_code]:rounded [&_p_code]:bg-foreground/[0.06] [&_p_code]:text-[85%] [&_p_code]:whitespace-normal [&_p_code]:[overflow-wrap:anywhere]',
        '[&_p]:my-1.5',
        '[&_ul]:my-1.5 [&_ul]:pl-4 [&_ul]:list-disc',
        '[&_ol]:my-1.5 [&_ol]:pl-4 [&_ol]:list-decimal',
        '[&_li]:my-0.5',
        '[&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2',
        '[&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5',
        '[&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-2 [&_h3]:mb-1',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border/50 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_a]:text-primary [&_a]:underline',
        '[&_hr]:border-border/30 [&_hr]:my-3',
        '[&_table]:text-[12px] [&_th]:px-2 [&_th]:py-1 [&_th]:border [&_th]:border-border/30 [&_th]:bg-muted/20 [&_td]:px-2 [&_td]:py-1 [&_td]:border [&_td]:border-border/30',
        className,
      )}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating,
);
MessageResponse.displayName = 'MessageResponse';
