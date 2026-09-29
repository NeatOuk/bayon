import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Every stage of Bayon's image is labelled: the classic builder keeps the build
// stage as an untagged image, and on the shared host an object of ours must be removable by label.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TEXT = readFileSync(`${HERE}Dockerfile`, "utf8");

/** The Dockerfile's stages: each FROM line through the line before the next. */
function stages(text: string): string[] {
  return text.split(/^(?=FROM )/m).filter((part) => part.startsWith("FROM "));
}

describe("deploy/Dockerfile", () => {
  test("has a build stage and a runtime stage", () => {
    const all = stages(TEXT);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatch(/^FROM \S+ AS build$/m);
  });

  test.each(stages(TEXT).map((stage) => [stage.split("\n")[0], stage]))(
    "%s carries frm.managed, frm.deploy and the revision",
    (_from, stage) => {
      expect(stage).toMatch(/^ARG REVISION=unknown$/m);
      expect(stage).toMatch(
        /^LABEL frm\.managed="1" frm\.deploy="bayon" org\.opencontainers\.image\.revision="\$\{REVISION\}"$/m,
      );
    },
  );

  test("the check would catch an unlabelled stage", () => {
    const unlabelled = TEXT.replace(/^LABEL .*\n/m, "");
    expect(
      stages(unlabelled).every((stage) =>
        /^LABEL frm\.managed="1"/m.test(stage),
      ),
    ).toBe(false);
  });
});
