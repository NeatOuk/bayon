import { z } from "zod";

const Choices = z.array(z.string().min(1)).min(1);

/** The asker's options when they are a list of strings: one click puts one in the answer. */
export const choicesOf = (options: unknown): readonly string[] => {
  const parsed = Choices.safeParse(options);
  return parsed.success ? parsed.data : [];
};
