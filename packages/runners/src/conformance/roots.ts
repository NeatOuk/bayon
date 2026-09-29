// §15 #16's one shared name, read by the suite's test and by every kit: the file the runner is
// asked to create in each extra workspace root, and once in a directory outside them all.
// Runner-neutral, and its own module so a kit can name it without importing the harness.
export const ROOT_MARKER = "FRM_ROOT.txt";
