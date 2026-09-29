import { createServer, type Server, type Socket } from "node:net";
import {
  NOTIFY_NTFY_URL_SECRET,
  NOTIFY_SMTP_URL_SECRET,
  NOTIFY_WEBHOOK_URL_SECRET,
} from "@bayon/core";
import { createTransport } from "nodemailer";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { z } from "zod";
import { scrubSecrets, urlSecretParts } from "../../secret-scrub.js";
import {
  fakeSecrets,
  startHookFixture,
  type HookFixture,
} from "../fixtures.js";
import type { Fetch, Outbound } from "./channel.js";
import {
  emailChannel,
  mailText,
  smtpOptions,
  type MakeTransport,
} from "./email.js";
import {
  MAC_SCRIPT,
  OSASCRIPT,
  macArgv,
  macChannel,
  type ExecFile,
} from "./mac.js";
import { headerText, ntfyChannel } from "./ntfy.js";
import { webhookChannel, webhookPayload } from "./webhook.js";

// Every channel against local stand-ins only: an `node:http` fixture for ntfy and the
// webhook (every https URL mapped to it), a stubbed execFile for osascript, and an in-process SMTP
// stub for email. No test sends a real notification. The secrets are fakes, and every error is
// checked for them in every form.

const PASSWORD = "ntfy-pw-5c1f9e";
const TOPIC = "bayon-topic-7f3a2d";
const NTFY_URL = `https://alice:${PASSWORD}@ntfy.fixture.test/${TOPIC}`;
const HOOK_PATH = "/services/T000/B000/hook-secret-91ab";
const WEBHOOK_URL = `https://hooks.fixture.test${HOOK_PATH}`;
const SLACK_URL = `https://hooks.slack.com${HOOK_PATH}`;
const MSG: Outbound = {
  title: "shop-builder asked on FRM-12",
  body: "Ship it behind a flag?",
  link: "https://bayon.lan:5173/#/p/shop/inbox?ticket=12",
};

let fx: HookFixture;
beforeAll(async () => {
  fx = await startHookFixture();
});
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  fx.seen.length = 0;
  fx.answers.length = 0;
});

/** Every form of every part of `url` that must never reach a message. */
const leaks = (text: string, url: string): string[] =>
  urlSecretParts(url)
    .flatMap((p) => [p, Buffer.from(p).toString("base64")])
    .filter((p) => p.length >= 6 && text.includes(p));

/**
 * The longest prefix of any of `secrets`' parts, 8 characters or more, that `text` holds: what a cut
 * made before the scrub would leave behind. "" when there is none.
 */
function leakedPrefix(text: string, secrets: readonly string[]): string {
  const parts = secrets.flatMap(urlSecretParts);
  for (const part of parts)
    for (let n = part.length; n >= 8; n -= 1)
      if (text.includes(part.slice(0, n))) return part.slice(0, n);
  return "";
}

const ntfy = (url = NTFY_URL, o: { fetch?: Fetch; timeoutMs?: number } = {}) =>
  ntfyChannel({
    secrets: fakeSecrets({ [NOTIFY_NTFY_URL_SECRET]: url }),
    fetch: o.fetch ?? fx.fetchVia(),
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  });

describe("ntfy", () => {
  test("POSTs the body to the topic with Title and Click, the userinfo as Basic auth that fetch never sees", async () => {
    let fetched = "";
    const via = fx.fetchVia();
    const spy: Fetch = (url, init) => {
      fetched = url;
      return via(url, init);
    };
    expect(await ntfy(NTFY_URL, { fetch: spy }).send(MSG)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fetched).toBe(`https://ntfy.fixture.test/${TOPIC}`);
    expect(fx.seen).toHaveLength(1);
    const [post] = fx.seen;
    expect(post?.method).toBe("POST");
    expect(post?.path).toBe(`/${TOPIC}`);
    expect(post?.body).toBe(MSG.body);
    expect(post?.headers.title).toBe(MSG.title);
    expect(post?.headers.click).toBe(MSG.link);
    expect(post?.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(post?.headers.authorization).toBe(
      `Basic ${Buffer.from(`alice:${PASSWORD}`).toString("base64")}`,
    );
  });

  test("a title that is not printable ASCII goes as RFC 2047; no link, no Click; an empty body sends the title", async () => {
    expect(headerText("Café\r\nBcc: x")).toBe(
      `=?UTF-8?B?${Buffer.from("Café Bcc: x").toString("base64")}?=`,
    );
    expect(headerText("plain")).toBe("plain");
    await ntfy(`https://ntfy.fixture.test/${TOPIC}`).send({
      title: "Déjà vu",
      body: "",
      link: null,
    });
    const [post] = fx.seen;
    expect(post?.headers.title).toBe(headerText("Déjà vu"));
    expect(post?.headers.click).toBeUndefined();
    expect(post?.headers.authorization).toBeUndefined();
    expect(post?.body).toBe("Déjà vu");
  });

  test("with no secret stored the channel is not configured, and sends nothing", async () => {
    const off = ntfyChannel({ secrets: fakeSecrets({}), fetch: fx.fetchVia() });
    expect(await off.configured()).toBe(false);
    expect(await off.send(MSG)).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    expect(await ntfy().configured()).toBe(true);
    expect(fx.seen).toEqual([]);
  });

  test("an http: URL is refused before any request, and not retried", async () => {
    let calls = 0;
    const counting: Fetch = (url, init) => {
      calls += 1;
      return fx.fetchVia()(url, init);
    };
    const r = await ntfy(`http://ntfy.fixture.test/${TOPIC}`, {
      fetch: counting,
    }).send(MSG);
    expect(r).toMatchObject({
      ok: false,
      error: { class: "validation", retryable: false },
    });
    if (!r.ok) expect(r.error.message).toContain("must be an https URL");
    expect(calls).toBe(0);
    expect(fx.seen).toEqual([]);
    expect(
      await ntfy("not a url", { fetch: counting }).send(MSG),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  });

  test("a redirect is refused, never followed: its target is never asked", async () => {
    fx.answers.push({
      status: 302,
      headers: { location: `${fx.origin}/stolen` },
    });
    const r = await ntfy().send(MSG);
    expect(r).toMatchObject({
      ok: false,
      error: { class: "runner_error", retryable: false },
    });
    if (!r.ok) {
      expect(r.error.message).toContain("redirect");
      expect(leaks(r.error.message, NTFY_URL)).toEqual([]);
    }
    expect(fx.seen.map((s) => s.path)).toEqual([`/${TOPIC}`]);
  });

  test("an answer that never comes is a retryable timeout", async () => {
    fx.answers.push({ hang: true });
    const r = await ntfy(NTFY_URL, { timeoutMs: 50 }).send(MSG);
    expect(r).toMatchObject({
      ok: false,
      error: { class: "timeout", retryable: true },
    });
  });

  test("429 and 5xx are retried, any other refusal is not; an answer echoing the secret is scrubbed", async () => {
    const echo = `denied ${NTFY_URL} ${PASSWORD} ${Buffer.from(`alice:${PASSWORD}`).toString("base64")} /${TOPIC}`;
    fx.answers.push(
      { status: 503, body: echo },
      { status: 429 },
      { status: 403, body: echo },
    );
    const results = [
      await ntfy().send(MSG),
      await ntfy().send(MSG),
      await ntfy().send(MSG),
    ];
    expect(results.map((r) => (r.ok ? "ok" : r.error.retryable))).toEqual([
      true,
      true,
      false,
    ]);
    for (const r of results) {
      if (r.ok) continue;
      expect(r.error.message).toMatch(/^ntfy answered HTTP \d{3}/);
      expect(leaks(r.error.message, NTFY_URL)).toEqual([]);
      expect(r.error.message).not.toContain(PASSWORD);
      expect(r.error.message).not.toContain(TOPIC);
    }
  });
});

test("an answer echoing a secret across the 200-character cut is scrubbed whole, then cut", async () => {
  // The password starts at offset 190: a cut at 200 made first would keep "ntfy-pw-5c".
  const echo = `${"x".repeat(190)}${PASSWORD} and ${NTFY_URL}`;
  expect(echo.slice(0, 200)).toContain(PASSWORD.slice(0, 10));
  fx.answers.push({ status: 500, body: echo });
  const r = await ntfy().send(MSG);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.message).toContain("<redacted>");
  expect(leakedPrefix(r.error.message, [NTFY_URL])).toBe("");
});

test("the Click header is one line, whatever the link held", async () => {
  await ntfy().send({ ...MSG, link: "https://bayon.lan/#/a\r\nX-Evil: 1" });
  const [post] = fx.seen;
  expect(post?.headers.click).toBe("https://bayon.lan/#/a X-Evil: 1");
  expect(post?.headers["x-evil"]).toBeUndefined();
});

describe("webhook", () => {
  const hook = (url: string) =>
    webhookChannel({
      secrets: fakeSecrets({ [NOTIFY_WEBHOOK_URL_SECRET]: url }),
      fetch: fx.fetchVia(),
    });

  test("a generic receiver gets {text, title, link} as JSON", async () => {
    expect((await hook(WEBHOOK_URL).send(MSG)).ok).toBe(true);
    const [post] = fx.seen;
    expect(post?.path).toBe(HOOK_PATH);
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(post?.body ?? "")).toEqual({
      text: MSG.body,
      title: MSG.title,
      link: MSG.link,
    });
  });

  test("Slack's host gets Slack's own {text}: the title bold, its controls escaped, the link as <url|label>", async () => {
    const o = {
      title: "A <b> & c",
      body: "x > y",
      link: "https://bayon.lan/#/a|b",
    };
    expect((await hook(SLACK_URL).send(o)).ok).toBe(true);
    expect(JSON.parse(fx.seen[0]?.body ?? "")).toEqual({
      text: "*A &lt;b&gt; &amp; c*\nx &gt; y\n<https://bayon.lan/#/a%7Cb|Open in Bayon>",
    });
    expect(
      JSON.parse(
        webhookPayload(SLACK_URL, { title: "t", body: "", link: null }),
      ),
    ).toEqual({
      text: "*t*",
    });
  });

  test("not configured without its secret; a redirect is refused as ntfy's is", async () => {
    const off = webhookChannel({
      secrets: fakeSecrets({}),
      fetch: fx.fetchVia(),
    });
    expect(await off.send(MSG)).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    fx.answers.push({
      status: 307,
      headers: { location: `${fx.origin}/elsewhere` },
    });
    expect(await hook(WEBHOOK_URL).send(MSG)).toMatchObject({
      ok: false,
      error: { retryable: false },
    });
    expect(fx.seen.map((s) => s.path)).toEqual([HOOK_PATH]);
  });
});

describe("mac", () => {
  const calls: { file: string; args: readonly string[]; timeout: number }[] =
    [];
  const recording: ExecFile = (file, args, options) => {
    calls.push({ file, args, timeout: options.timeout });
    return Promise.resolve();
  };
  beforeEach(() => {
    calls.length = 0;
  });

  test("the title and body reach osascript only as argv after --, never inside the script", async () => {
    const title = `Q "quoted" 'single' $(touch /tmp/pwned) \`id\` end`;
    const body = `" & (do shell script "id") & "`;
    const mac = macChannel({ platform: "darwin", execFile: recording });
    expect(await mac.send({ title, body, link: MSG.link })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(calls).toEqual([
      {
        file: OSASCRIPT,
        args: [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          "--",
          title,
          body,
        ],
        timeout: 10_000,
      },
    ]);
    // The script is constant: nothing before `--` holds any byte of either value.
    const script = calls[0]?.args.slice(0, calls[0].args.indexOf("--")) ?? [];
    expect(script).toEqual(MAC_SCRIPT.flatMap((line) => ["-e", line]));
    for (const line of script) {
      expect(line).not.toContain("quoted");
      expect(line).not.toContain("do shell script");
    }
    expect(macArgv("a", "b").slice(-3)).toEqual(["--", "a", "b"]);
  });

  test("a title or body that looks like an option (-e, --) is data after --, never a flag", async () => {
    const mac = macChannel({ platform: "darwin", execFile: recording });
    for (const [title, body] of [
      ["-e", "--"],
      ["--", '-e do shell script "id"'],
      ["-e", "-l JavaScript"],
    ] as const) {
      expect((await mac.send({ title, body, link: null })).ok).toBe(true);
      const args = calls.at(-1)?.args ?? [];
      expect(args).toEqual([
        ...MAC_SCRIPT.flatMap((line) => ["-e", line]),
        "--",
        title,
        body,
      ]);
      // The script ends at the first `--`, and the values come after it and nowhere else.
      expect(args.indexOf("--")).toBe(MAC_SCRIPT.length * 2);
      expect(args.slice(0, args.indexOf("--"))).not.toContain(body);
    }
  });

  test("off macOS it is unavailable: not configured, and osascript is never run", async () => {
    const linux = macChannel({ platform: "linux", execFile: recording });
    expect(await linux.configured()).toBe(false);
    expect(await linux.send(MSG)).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    expect(calls).toEqual([]);
    expect(
      await macChannel({
        platform: "darwin",
        execFile: recording,
      }).configured(),
    ).toBe(true);
  });

  test("osascript killed by its timeout is a timeout; any other failure is retried", async () => {
    const killed: ExecFile = () =>
      Promise.reject(
        Object.assign(new Error("Command failed"), { killed: true }),
      );
    const failed: ExecFile = () =>
      Promise.reject(new Error("execution error: -1743"));
    expect(
      await macChannel({ platform: "darwin", execFile: killed }).send(MSG),
    ).toMatchObject({
      ok: false,
      error: { class: "timeout", retryable: true },
    });
    expect(
      await macChannel({ platform: "darwin", execFile: failed }).send(MSG),
    ).toMatchObject({
      ok: false,
      error: { class: "runner_error", retryable: true },
    });
  });
});

// An in-process SMTP server: enough of RFC 5321 for one message, recording every line it reads.
interface SmtpStub {
  readonly port: number;
  readonly lines: string[];
  /** While true, AUTH is refused with a 535 that echoes the credentials back. */
  refuseAuth: boolean;
  close(): Promise<void>;
}

async function startSmtpStub(): Promise<SmtpStub> {
  const sockets = new Set<Socket>();
  const stub = { lines: [] as string[], refuseAuth: false };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let inData = false;
    const say = (line: string) => socket.write(`${line}\r\n`);
    say("220 stub.fixture.test ESMTP");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let at = buffer.indexOf("\r\n");
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        stub.lines.push(line);
        if (inData) {
          if (line === ".") {
            inData = false;
            say("250 2.0.0 queued");
          }
        } else if (/^(EHLO|HELO)/i.test(line)) {
          socket.write(
            "250-stub.fixture.test\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n",
          );
        } else if (/^AUTH/i.test(line)) {
          say(
            stub.refuseAuth
              ? `535 5.7.8 credentials rejected: ${line}`
              : "235 2.7.0 ok",
          );
        } else if (/^(MAIL|RCPT)/i.test(line)) {
          say("250 2.1.0 ok");
        } else if (/^DATA/i.test(line)) {
          inData = true;
          say("354 go ahead");
        } else if (/^QUIT/i.test(line)) {
          say("221 bye");
          socket.end();
        } else {
          say("250 ok");
        }
        at = buffer.indexOf("\r\n");
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = z.object({ port: z.int() }).parse(server.address());
  return Object.assign(stub, {
    port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

describe("email", () => {
  const SMTP_PASS = "smtp-pw-2e8d4b";
  const SMTP_URL = `smtps://mailer%40acme.test:${SMTP_PASS}@smtp.fixture.test:465`;
  let smtp: SmtpStub;
  beforeAll(async () => {
    smtp = await startSmtpStub();
  });
  afterAll(async () => {
    await smtp.close();
  });
  beforeEach(() => {
    smtp.lines.length = 0;
    smtp.refuseAuth = false;
  });

  /** nodemailer's real SMTP transport, pointed at the stub in the clear: the stub speaks no TLS. */
  const toStub: MakeTransport = (o) =>
    createTransport({
      ...o,
      auth: o.auth === undefined ? undefined : { ...o.auth },
      host: "127.0.0.1",
      port: smtp.port,
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
    });

  const channel = (to = "op@example.test", from = "") =>
    emailChannel({
      secrets: fakeSecrets({ [NOTIFY_SMTP_URL_SECRET]: SMTP_URL }),
      parties: () => Promise.resolve({ to, from }),
      makeTransport: toStub,
    });

  test("the URL: smtps is TLS from the start, smtp must STARTTLS; anything else is refused unquoted", () => {
    expect(smtpOptions(SMTP_URL)).toMatchObject({
      ok: true,
      value: {
        host: "smtp.fixture.test",
        port: 465,
        secure: true,
        requireTLS: false,
        auth: { user: "mailer@acme.test", pass: SMTP_PASS },
        tls: { minVersion: "TLSv1.2" },
      },
    });
    expect(smtpOptions("smtp://relay.fixture.test")).toMatchObject({
      ok: true,
      value: { port: 587, secure: false, requireTLS: true },
    });
    const relay = smtpOptions("smtp://relay.fixture.test");
    if (relay.ok) expect(relay.value.auth).toBeUndefined();
    const bad = smtpOptions(`https://mailer:${SMTP_PASS}@smtp.fixture.test`);
    expect(bad).toMatchObject({
      ok: false,
      error: { class: "validation", retryable: false },
    });
    if (!bad.ok) expect(bad.error.message).not.toContain(SMTP_PASS);
    expect(mailText({ title: "t", body: "b", link: null })).toBe("b");
    expect(mailText(MSG)).toBe(`${MSG.body}\n\n${MSG.link}`);
  });

  test("one message to the stub: the envelope, the subject and the link in the text", async () => {
    expect(await channel().send(MSG)).toEqual({ ok: true, value: undefined });
    expect(smtp.lines).toContain("MAIL FROM:<mailer@acme.test>");
    expect(smtp.lines).toContain("RCPT TO:<op@example.test>");
    expect(smtp.lines).toContain(`Subject: ${MSG.title}`);
    expect(smtp.lines).toContain(MSG.link);
    expect(smtp.lines.some((l) => l.startsWith("AUTH PLAIN"))).toBe(true);
  });

  test("a title with line breaks is one Subject line, never a second header", async () => {
    await channel().send({
      ...MSG,
      title: "Line one\r\nBcc: evil@example.test",
    });
    expect(smtp.lines).toContain("Subject: Line one Bcc: evil@example.test");
    expect(smtp.lines).not.toContain("Bcc: evil@example.test");
    expect(smtp.lines.filter((l) => l.startsWith("RCPT TO"))).toEqual([
      "RCPT TO:<op@example.test>",
    ]);
  });

  test("notify.email.from wins over the SMTP user; no sender at all is refused", async () => {
    await channel("op@example.test", "bayon@example.test").send(MSG);
    expect(smtp.lines).toContain("MAIL FROM:<bayon@example.test>");
    const noUser = emailChannel({
      secrets: fakeSecrets({
        [NOTIFY_SMTP_URL_SECRET]: "smtps://relay:pw@smtp.fixture.test",
      }),
      parties: () => Promise.resolve({ to: "op@example.test", from: "" }),
      makeTransport: toStub,
    });
    expect(await noUser.send(MSG)).toMatchObject({
      ok: false,
      error: { class: "validation", retryable: false },
    });
  });

  test("no recipient or no URL is not configured", async () => {
    expect(await channel("").configured()).toBe(false);
    expect(await channel("").send(MSG)).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    const noUrl = emailChannel({
      secrets: fakeSecrets({}),
      parties: () => Promise.resolve({ to: "op@example.test", from: "" }),
    });
    expect(await noUrl.configured()).toBe(false);
    expect(await noUrl.send(MSG)).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    expect(await channel().configured()).toBe(true);
  });

  test("a refused login, echoing the AUTH line back, is scrubbed and not retried", async () => {
    smtp.refuseAuth = true;
    const r = await channel().send(MSG);
    expect(r).toMatchObject({
      ok: false,
      error: { class: "runner_error", retryable: false },
    });
    if (r.ok) return;
    const plain = Buffer.from(`\0mailer@acme.test\0${SMTP_PASS}`).toString(
      "base64",
    );
    // The stub did see the credentials: the scrub is what keeps them out.
    expect(smtp.lines.some((l) => l.includes(plain))).toBe(true);
    expect(r.error.message).not.toContain(plain);
    expect(r.error.message).not.toContain(SMTP_PASS);
    expect(leaks(r.error.message, SMTP_URL)).toEqual([]);
  });

  test("an SMTP error echoing the password across the 300-character cut is scrubbed whole, then cut", async () => {
    const echoing = emailChannel({
      secrets: fakeSecrets({ [NOTIFY_SMTP_URL_SECRET]: SMTP_URL }),
      parties: () => Promise.resolve({ to: "op@example.test", from: "" }),
      makeTransport: () => ({
        // "the SMTP send failed: " comes first; the password starts at offset 290 of the error.
        sendMail: () =>
          Promise.reject(
            new Error(`${"y".repeat(290)}${SMTP_PASS} ${SMTP_URL}`),
          ),
        close: () => undefined,
      }),
    });
    const r = await echoing.send(MSG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("<redacted>");
    expect(leakedPrefix(r.error.message, [SMTP_URL])).toBe("");
  });

  test("a transport that throws the password is scrubbed; one that never answers is a timeout", async () => {
    const throwing = emailChannel({
      secrets: fakeSecrets({ [NOTIFY_SMTP_URL_SECRET]: SMTP_URL }),
      parties: () => Promise.resolve({ to: "op@example.test", from: "" }),
      makeTransport: () => ({
        sendMail: () =>
          Promise.reject(
            new Error(
              `connect failed for mailer@acme.test:${SMTP_PASS} ${SMTP_URL}`,
            ),
          ),
        close: () => undefined,
      }),
    });
    const r = await throwing.send(MSG);
    expect(r).toMatchObject({ ok: false, error: { retryable: true } });
    if (!r.ok) expect(leaks(r.error.message, SMTP_URL)).toEqual([]);
    let closed = false;
    const hanging = emailChannel({
      secrets: fakeSecrets({ [NOTIFY_SMTP_URL_SECRET]: SMTP_URL }),
      parties: () => Promise.resolve({ to: "op@example.test", from: "" }),
      sendTimeoutMs: 20,
      makeTransport: () => ({
        sendMail: () => new Promise(() => undefined),
        close: () => {
          closed = true;
        },
      }),
    });
    expect(await hanging.send(MSG)).toMatchObject({
      ok: false,
      error: { class: "timeout", retryable: true },
    });
    expect(closed).toBe(true);
  });
});

describe("the scrub", () => {
  test("a secret goes in every form: raw, base64 with and without padding, base64url, %-encoded", () => {
    const s = "p@ss/w+rd?==";
    const forms = [
      s,
      Buffer.from(s).toString("base64"),
      Buffer.from(s).toString("base64").replace(/=+$/, ""),
      Buffer.from(s).toString("base64url"),
      encodeURIComponent(s),
    ];
    const out = scrubSecrets(forms.join(" | "), [s]);
    for (const f of forms) expect(out).not.toContain(f);
    expect(out.split("<redacted>")).toHaveLength(forms.length + 1);
    expect(scrubSecrets("nothing here", ["", "absent"])).toBe("nothing here");
  });

  test("a URL's secret parts: the whole, its userinfo and password, AUTH PLAIN's form, its path", () => {
    const parts = urlSecretParts("https://u%40x:p%2Fw@host.test/topic?t=1");
    expect(parts).toEqual(
      expect.arrayContaining([
        "https://u%40x:p%2Fw@host.test/topic?t=1",
        "p%2Fw",
        "p/w",
        "u@x:p/w",
        "\0u@x\0p/w",
        "https://host.test/topic?t=1",
        "/topic?t=1",
      ]),
    );
    expect(parts).not.toContain("host.test");
    expect(urlSecretParts("not a url")).toEqual(["not a url"]);
  });
});
