// the kill switch refuses work on an executor the operator took out of service, with
// the class and the gate admission's own `disabled` refusal uses, and a message that names the
// executor and says how to put it back.
import { expect, test } from "vitest";
import { AdmissionRefusalCause } from "./admission-gates.js";
import { disabledExecutorRefusal } from "./executor-disabled.js";

test("an enabled executor: no refusal", () => {
  expect(
    disabledExecutorRefusal({ executorId: "local", enabled: true }),
  ).toBeNull();
});

test("a disabled executor: admission_refused at the disabled gate, not retryable", () => {
  const refusal = disabledExecutorRefusal({
    executorId: "ctr-1",
    enabled: false,
  });
  expect(refusal).toMatchObject({
    class: "admission_refused",
    retryable: false,
  });
  expect(refusal?.message).toContain("executor ctr-1 is disabled");
  expect(refusal?.message).toContain("frm executor enable ctr-1");
  expect(AdmissionRefusalCause.parse(refusal?.cause).gate).toBe("disabled");
});
