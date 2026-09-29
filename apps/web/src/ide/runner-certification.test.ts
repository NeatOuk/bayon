import { expect, test } from "vitest";
import { certification, modelView, runnerView } from "@/test/runner-fixtures";
import {
  certificationLabel,
  certificationOn,
} from "@/ide/runner-certification";

// A runner's certification on one executor, as the Add agent dialog names it.

test("certified, not certified, decertified or never run, on the executor asked about only", () => {
  // The fixture's runner-a binds its cheap model to a role: the model its certificate is for.
  const onLocal = (o: Parameters<typeof certification>[0]) =>
    runnerView({ id: "runner-a", certifications: [certification(o)] });
  expect(certificationOn(onLocal({}), "local")).toBe("certified");
  expect(certificationOn(onLocal({ passed_at: null }), "local")).toBe(
    "not certified",
  );
  expect(
    certificationOn(onLocal({ decertified_at: 1, passed_at: null }), "local"),
  ).toBe("decertified");
  expect(certificationOn(onLocal({}), "ctr-1")).toBe("never run");
  expect(
    certificationOn(
      runnerView({
        id: "runner-b",
        certifications: [certification({ executor_id: "ctr-1" })],
      }),
      "local",
    ),
  ).toBe("never run");
  expect(certificationLabel(onLocal({ passed_at: null }), "local")).toBe(
    "not certified on local",
  );
});

test("per model: a certificate of a model no role runs does not certify the runner", () => {
  const complexOnly = runnerView({
    id: "runner-a",
    certifications: [
      certification({ model_id: "runner-a.complex", model: "model-large" }),
    ],
  });
  expect(certificationOn(complexOnly, "local")).toBe("not certified");
  // No model bound to a role: every active model counts.
  const unbound = runnerView({
    id: "runner-a",
    models: [modelView({ id: "runner-a.cheap", tier: "cheap", model: "s" })],
    certifications: [certification({ model_id: "runner-a.cheap" })],
  });
  expect(certificationOn(unbound, "local")).toBe("certified");
});

test("per context compression: the normal badge counts the off certificates, the compression badge the on ones", () => {
  const onOnly = runnerView({
    id: "runner-a",
    certifications: [certification({ compression: true })],
  });
  // Only a compression-on certificate: the runner's normal badge has never run.
  expect(certificationOn(onOnly, "local")).toBe("never run");
  expect(certificationOn(onOnly, "local", { compression: true })).toBe(
    "certified",
  );
  expect(certificationLabel(onOnly, "local", { compression: true })).toBe(
    "certified on local with compression",
  );
  const both = runnerView({
    id: "runner-a",
    certifications: [
      certification({}),
      certification({ compression: true, passed_at: null }),
    ],
  });
  expect(certificationOn(both, "local")).toBe("certified");
  expect(certificationOn(both, "local", { compression: true })).toBe(
    "not certified",
  );
  expect(certificationLabel(both, "local")).toBe("certified on local");
});
