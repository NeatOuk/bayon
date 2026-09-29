// A diff's lines, one recipe for every diff the GUI draws: an added line on the success
// tone's soft surface, a removed one on danger's, the text in the foreground (4.5:1 on both surfaces
// in both themes, colours.test.ts). The +/- marks stay, so colour is never the only signal.

export const DIFF_ADDED = "bg-success-subtle text-foreground";
export const DIFF_REMOVED = "bg-danger-subtle text-foreground";
