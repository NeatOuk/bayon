import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

// One link, instead of eight hand-copied class recipes: the primary colour, an underline
// on hover and on keyboard focus, and the focus ring every control draws. A link inside running prose
// keeps a quiet underline (`inline`): the primary colour against body text is under the 3:1 that
// would let colour alone mark it (WCAG 1.4.1).

/** The ring a keyboard focus draws (control ring), for any focusable that is not a control. */
export const FOCUS_RING =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring";

/**
 * A link stretched over its whole row or card (`relative` on the container): the ring is drawn on the
 * stretched box, so the focused thing is the row the link stands for.
 */
export const STRETCHED_LINK =
  "outline-none after:absolute after:inset-0 after:rounded-md hover:underline focus-visible:after:outline-2 focus-visible:after:outline-solid focus-visible:after:outline-ring";

/** The link recipe, for an element that renders a link through another component's `render`. */
export const textLinkClass = ({
  inline = false,
}: { readonly inline?: boolean } = {}): string =>
  cn(
    "rounded-xs text-primary underline-offset-4 hover:underline focus-visible:underline",
    inline && "underline decoration-primary/40 hover:decoration-primary",
    FOCUS_RING,
  );

/** A link off this app: an absolute http(s) URL. */
export const isExternal = (href: string): boolean => /^https?:\/\//i.test(href);

/**
 * A text link. An external one (an absolute http(s) URL, or `external`) opens a new tab without
 * handing it this window (`noreferrer noopener`), and says so: an icon, and the words for a screen
 * reader.
 */
export function TextLink({
  href,
  external,
  inline = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"a">, "href" | "target" | "rel"> & {
  readonly href: string;
  readonly external?: boolean;
  readonly inline?: boolean;
}) {
  const outside = external ?? isExternal(href);
  return (
    <a
      data-slot="text-link"
      href={href}
      className={cn(textLinkClass({ inline }), className)}
      {...(outside ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      {...props}
    >
      {children}
      {outside && (
        <>
          <ExternalLink
            aria-hidden="true"
            className="ml-0.5 inline size-3 align-[-0.125em]"
          />{" "}
          <span className="sr-only">(opens in a new tab)</span>
        </>
      )}
    </a>
  );
}
