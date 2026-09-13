/**
 * The Crew AI mark: three agents around the person they work for.
 *
 * An open ring of three arcs — the crew — around one dot — you, the name they
 * are all issued under. The ring is open on the right so it still reads as a
 * "C" at sixteen pixels, where the arcs are the only detail that survives.
 *
 * Inline SVG rather than the file in /public, so it takes the theme's primary
 * colour and stays sharp at every size. `public/crewai-mark.svg` is the same
 * drawing with the colours fixed, for the favicon and anywhere outside the app.
 */
import { cn } from '@/lib/utils';

export const CrewMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 32 32" aria-hidden className={cn('size-6 shrink-0', className)}>
    <rect width="32" height="32" rx="8" className="fill-primary" />
    <g fill="none" strokeWidth="3" strokeLinecap="round" className="stroke-primary-foreground">
      <path d="M21.657 21.657A8 8 0 0 1 12.874 23.364" />
      <path d="M9.368 20.474A8 8 0 0 1 9.368 11.526" />
      <path d="M12.874 8.636A8 8 0 0 1 21.657 10.343" />
    </g>
    <circle cx="16" cy="16" r="2.4" className="fill-primary-foreground" />
  </svg>
);
