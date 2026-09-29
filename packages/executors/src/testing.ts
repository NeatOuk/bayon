export {
  FakeExecutor,
  type FakeExecutorOptions,
  type FakeIo,
  type FakeProgram,
  type FakePty,
  type FakeWriter,
} from "./fake.js";
export { LoopbackTransport } from "./container/loopback.js";
export {
  FAKE_IMAGE_ID,
  installFakeDocker,
  type FakeDocker,
} from "./container/fake-docker.js";
