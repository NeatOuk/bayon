import { toExecutorConfig } from "@bayon/api/src/executors/executor-plan.js";
import type { CreateExecutorRequest } from "@bayon/proto";
import { expect, test } from "vitest";
import { parseExecutorCli } from "./executor.js";

// `frm executor add` and `POST /executors` must build identical `{ssh, config}`
// objects for the same input: the whole point of lifting the assembly into one pure function,
// asserted directly rather than trusted (the same pattern as project-plan.equality.test.ts).

function unwrapAdd(argv: readonly string[]) {
  const cmd = parseExecutorCli(argv);
  if (!cmd.ok) throw new Error(cmd.error.message);
  if (cmd.value.action !== "add") throw new Error("not an add command");
  return cmd.value;
}

test("the default shape (only the required flags)", () => {
  const cli = unwrapAdd([
    "add",
    "ctr-eq",
    "--host",
    "192.0.2.10",
    "--user",
    "ops",
    "--identity-ref",
    "file:/keys/id_ed25519",
    "--remote-root",
    "/home/ops/frm",
  ]);
  const body: CreateExecutorRequest = {
    id: "ctr-eq",
    host: "192.0.2.10",
    user: "ops",
    identity_ref: "file:/keys/id_ed25519",
    remote_root: "/home/ops/frm",
    slots: 2,
  };
  const api = toExecutorConfig(body);
  expect(cli.ssh).toEqual(api.ssh);
  expect(cli.config).toEqual(api.config);
});

test("every optional flag set", () => {
  const cli = unwrapAdd([
    "add",
    "ctr-eq",
    "--host",
    "192.0.2.10",
    "--port",
    "2222",
    "--user",
    "ops",
    "--identity-ref",
    "agent:/keys/id_ed25519.pub",
    "--remote-root",
    "/home/ops/frm",
    "--network",
    "custom-net",
    "--egress-allow",
    "a.example.com,b.example.com",
    "--base-image",
    "node:22-trixie-slim",
    "--min-free-pct",
    "20",
    "--quota-gb",
    "30",
  ]);
  const body: CreateExecutorRequest = {
    id: "ctr-eq",
    host: "192.0.2.10",
    port: 2222,
    user: "ops",
    identity_ref: "agent:/keys/id_ed25519.pub",
    remote_root: "/home/ops/frm",
    slots: 2,
    network: "custom-net",
    egress_allow: ["a.example.com", "b.example.com"],
    base_image: "node:22-trixie-slim",
    min_free_pct: 20,
    quota_gb: 30,
  };
  const api = toExecutorConfig(body);
  expect(cli.ssh).toEqual(api.ssh);
  expect(cli.config).toEqual(api.config);
});
