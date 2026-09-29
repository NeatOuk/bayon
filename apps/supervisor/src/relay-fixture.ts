// A standalone process for relay.test.ts's real cross-process test: opens a relay server at
// argv[2] and registers one echo channel named argv[3]. Prints "ready" once listening, so the
// test knows when it's safe to connect. Not part of the supervisor's own startup — this exists
// only so a test can spawn a real second OS process without booting the whole supervisor.
import { pino } from "pino";
import { openRelayServer } from "./relay.js";

const path = process.argv[2];
const channelId = process.argv[3];
if (path === undefined || channelId === undefined) {
  console.error("usage: relay-fixture.js <socket-path> <channel-id>");
  process.exit(1);
}

const log = pino({ level: "silent" });

const server = await openRelayServer({ path, log });
if (!server.ok) {
  console.error(`relay-fixture: ${server.error.message}`);
  process.exit(1);
}
const sink = server.value.register(channelId, {
  onData: (bytes) => {
    if (sink.ok) sink.value.write(Buffer.concat([Buffer.from("echo:"), bytes]));
  },
  onClose: () => undefined,
});
console.log("ready");
