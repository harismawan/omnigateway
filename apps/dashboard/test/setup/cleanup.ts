import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";
import { restoreSocketStub } from "../helpers/socketStub.ts";

afterEach(() => {
  // Unmount first: that is what stops the stream client, cancels its retry and
  // closes its socket. Poisoning the constructor before the trees came down
  // would turn an ordinary teardown into a thrown error.
  cleanup();
  restoreSocketStub();
});
