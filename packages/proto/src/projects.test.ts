import { expect, test } from "vitest";
import { CreateProjectRequest } from "./projects.js";

const BASE = {
  name: "demo",
  repo_url: "https://example.com/app.git",
  runner_id: "fixture",
};

test("executor_id defaults to local, orchestrator defaults to true", () => {
  const parsed = CreateProjectRequest.parse(BASE);
  expect(parsed).toMatchObject({ executor_id: "local", orchestrator: true });
  expect(parsed).not.toHaveProperty("reviewer_runner_id");
});

test("reviewer_runner_id: absent vs explicit null are distinct", () => {
  expect(CreateProjectRequest.parse(BASE)).not.toHaveProperty(
    "reviewer_runner_id",
  );
  expect(
    CreateProjectRequest.parse({ ...BASE, reviewer_runner_id: null })
      .reviewer_runner_id,
  ).toBeNull();
  expect(
    CreateProjectRequest.parse({ ...BASE, reviewer_runner_id: "critic" })
      .reviewer_runner_id,
  ).toBe("critic");
});

test("an unknown field is refused (strict)", () => {
  expect(CreateProjectRequest.safeParse({ ...BASE, bogus: 1 }).success).toBe(
    false,
  );
});

test("a blank name or repo_url is refused", () => {
  expect(CreateProjectRequest.safeParse({ ...BASE, name: "" }).success).toBe(
    false,
  );
  expect(
    CreateProjectRequest.safeParse({ ...BASE, repo_url: "" }).success,
  ).toBe(false);
});
