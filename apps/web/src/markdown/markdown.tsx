import ReactMarkdown, { type Components } from "react-markdown";
import { TextLink } from "@/components/text-link";

// Tailwind has no typography reset here, so the rendered elements get sizes and spacing from the
// wrapper; colours stay the theme's tokens.
const PROSE = [
  "flex flex-col gap-2 text-sm leading-relaxed",
  "[&_h1]:font-head [&_h1]:text-xl",
  "[&_h2]:mt-2 [&_h2]:font-head [&_h2]:text-base",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_code]:bg-muted [&_code]:px-1",
  "[&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted [&_pre]:p-2",
].join(" ");

/**
 * A link in written text is the one link, underlined because it sits in prose; one off
 * this app opens a new tab without handing it this window.
 */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <TextLink href={href ?? ""} inline>
      {children}
    </TextLink>
  ),
};

/** Operator- or agent-written markdown (missions, ticket bodies). Raw HTML stays text. */
export function Markdown({ markdown }: { readonly markdown: string }) {
  return (
    <div className={PROSE}>
      <ReactMarkdown components={COMPONENTS}>{markdown}</ReactMarkdown>
    </div>
  );
}
