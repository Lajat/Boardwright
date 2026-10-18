interface LogoProps {
  /** Pixel size of the whole mark (the colored box) — pass the pixel equivalent of whatever Tailwind h-/w- size the call site used before. */
  size?: number;
  className?: string;
  /** Background color class — brand-600 almost everywhere, but the invite page sits on a dark background and uses the lighter brand-500 so the mark doesn't disappear into it. */
  bgClassName?: string;
}

/**
 * The app's brand mark — a colored box with three fanned, overlapping
 * rounded cards.
 *
 * This renders the EXACT same geometry as the static brand asset
 * (public/brand/logo.svg, also used in the README and the About page) —
 * same viewBox, same rects, same transforms, copied over rather than
 * redrawn. An earlier version of this component hand-drew its own
 * "simplified" two-card version for small sizes, which quietly diverged
 * into a shape that didn't actually match the real logo anymore. Sharing
 * the literal geometry is what makes that impossible instead of just
 * unlikely: there is nothing left here to independently get wrong.
 *
 * This is the ONE in-app place the mark is defined. Every header/login/
 * signup/invite page that shows the app's logo renders this component
 * rather than each hand-rolling its own wrapper + icon — so a future
 * restyle is a single edit here instead of hunting down every call site
 * again the way the icon was briefly out of sync with the name after the
 * Fluxboard → Boardwright rename, and the way this component itself was
 * briefly out of sync with the logo it was supposed to be.
 */
export function Logo({ size = 24, className = "", bgClassName = "bg-brand-600" }: LogoProps) {
  return (
    <div
      style={{ width: size, height: size }}
      className={`flex shrink-0 items-center justify-center rounded-[28%] ${bgClassName} ${className}`}
    >
      {/* Hardcoded hex, not currentColor — these must render identically to
          logo.svg regardless of bgClassName (brand-600 here, brand-500 on
          the dark invite page). Only the outer box color is meant to vary
          per call site; the card artwork itself never should, or the two
          "sources of truth" quietly stop matching again, the exact bug
          this component exists to prevent. */}
      <svg viewBox="0 0 512 512" width="68%" height="68%" xmlns="http://www.w3.org/2000/svg">
        <rect x="128" y="256" width="168" height="168" rx="32" fill="#4338ca" fillOpacity="0.55" transform="rotate(-12 212 340)" />
        <rect x="168" y="192" width="168" height="168" rx="32" fill="#4338ca" fillOpacity="0.8" transform="rotate(-4 252 276)" />
        <rect x="208" y="128" width="168" height="168" rx="32" fill="#ffffff" transform="rotate(6 292 212)" />
      </svg>
    </div>
  );
}
