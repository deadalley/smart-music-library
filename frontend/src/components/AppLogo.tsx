// The monochrome app mark (record + analytics bars, no tile) lives in
// public/logo-mark.svg and is applied as a CSS mask over `currentColor`, so
// it takes the text colour (e.g. `text-primary`) like an icon font would.
// Using it as an image also keeps the page's CSS from interfering with the
// SVG's internal masks.
const MARK_URL = "/logo-mark.svg";

export function AppLogo({
  className = "",
  title,
}: {
  className?: string;
  /** Accessible name; omit when the logo sits next to the app name. */
  title?: string;
}) {
  return (
    <span
      className={`inline-block shrink-0 bg-current ${className}`}
      style={{
        maskImage: `url(${MARK_URL})`,
        maskRepeat: "no-repeat",
        maskPosition: "center",
        maskSize: "contain",
        WebkitMaskImage: `url(${MARK_URL})`,
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        WebkitMaskSize: "contain",
      }}
      {...(title
        ? { role: "img", "aria-label": title }
        : { "aria-hidden": true })}
    />
  );
}
