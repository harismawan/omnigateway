import type { StreamTimer } from "../../src/session/stream.tsx";

/**
 * Replaces `globalThis.WebSocket` with something inert.
 *
 * ## Why this is not optional
 *
 * happy-dom 20 implements `WebSocket` as a real `ws`-backed network client — its
 * `lib/web-socket/WebSocket.js` imports `ws` and connects from the constructor —
 * and `GlobalRegistrator.register()` copies that over Bun's own global. So a
 * test that mounts the stream provider without this installed opens a *real*
 * socket to whatever `window.location` says, and fails asynchronously, possibly
 * after the test that opened it has finished. `createFetchStub` cannot help:
 * an upgrade is not a `fetch`.
 *
 * Both `globalThis` and `window` are assigned, mirroring the `ResizeObserver`
 * precedent in `test/setup/happydom.ts` — happy-dom's window is a distinct
 * object and code reaching it either way must find the stub.
 *
 * ## The constructor does not connect
 *
 * It records the socket and stops. A test calls `open()` when it wants the
 * connected state, which removes every `waitFor` that would otherwise exist
 * only to reach a state the test is not testing.
 *
 * ## `restore()` poisons rather than restores
 *
 * `restore()` installs a constructor that throws, and deliberately does not put
 * happy-dom's real client back. Putting it back is the one thing that would let
 * the failure this file exists to prevent happen anyway: an orphaned reconnect
 * timer from a finished test fires, constructs "the real thing", and opens a
 * network connection from a unit suite. Throwing names the leak instead, and
 * since `test/setup/cleanup.ts` runs `restore()` after every test, no dashboard
 * test can reach a real socket even if it never installs the stub.
 */

/**
 * A frame in either direction, loosely typed on purpose: a test reads what the
 * client wrote and writes what a gateway would answer, and both live here so a
 * malformed frame is something a test can send rather than something only the
 * gateway could produce.
 */
export type StubFrame = {
  type: string;
  topic?: string;
  seq?: number;
  sinceSeq?: number;
  payload?: unknown;
};

type StubState = {
  sockets: StubSocket[];
  onSend: ((socket: StubSocket, data: string) => void) | null;
};

let active: StubState | null = null;

export class StubSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  /** Every frame the client wrote, in order, as the JSON it would have sent. */
  readonly sent: string[] = [];
  readyState = StubSocket.CONNECTING;

  constructor(url: string) {
    super();
    if (active === null) {
      throw new Error(
        `a dashboard test constructed a WebSocket (${url}) with no socket stub installed — ` +
          "call installSocketStub() in the test, or find the timer that outlived one",
      );
    }
    this.url = url;
    active.sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
    active?.onSend?.(this, data);
  }

  /** Completes the upgrade. Nothing happens until a test asks for it. */
  open(): void {
    this.readyState = StubSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** Delivers one server frame through the real `message` listener path. */
  emit(frame: StubFrame): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  /**
   * Closes, from either side: the client calls this on unmount and a test calls
   * it to drop the connection. A real `CloseEvent` either way, so the code under
   * test reads `event.code` exactly as it does in a browser.
   */
  close(code = 1000, reason = ""): void {
    if (this.readyState === StubSocket.CLOSED) return;
    this.readyState = StubSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
  }

  /** The frames this socket was asked to send, parsed. */
  frames(): StubFrame[] {
    return this.sent.map((raw): StubFrame => JSON.parse(raw) as StubFrame);
  }

  /** Answers every outstanding subscribe with an `ack`, as a healthy gateway does. */
  ackAll(): void {
    for (const frame of this.frames()) {
      if (frame.type === "subscribe" && frame.topic !== undefined) {
        this.emit({ type: "ack", topic: frame.topic });
      }
    }
  }
}

class PoisonedWebSocket {
  constructor(url: string) {
    throw new Error(
      `a dashboard test opened a WebSocket (${url}) after its socket stub was torn down — ` +
        "something scheduled a reconnect that outlived the render",
    );
  }
}

export type SocketStub = {
  /** Every socket constructed since install. Its length is the reconnect count. */
  sockets: StubSocket[];
  /** Called for each frame written, on any socket — for asserting ordering. */
  onSend: ((socket: StubSocket, data: string) => void) | null;
  /** The most recent socket, or a thrown error naming the missing connection. */
  last(): StubSocket;
};

function install(ctor: unknown): void {
  globalThis.WebSocket = ctor as typeof WebSocket;
  window.WebSocket = ctor as typeof WebSocket;
}

export function installSocketStub(): SocketStub {
  const state: StubState = { sockets: [], onSend: null };
  active = state;
  install(StubSocket);
  return {
    sockets: state.sockets,
    get onSend() {
      return state.onSend;
    },
    set onSend(handler: ((socket: StubSocket, data: string) => void) | null) {
      state.onSend = handler;
    },
    last() {
      const socket = state.sockets.at(-1);
      if (socket === undefined) throw new Error("no socket has been constructed");
      return socket;
    },
  };
}

/** Run from `test/setup/cleanup.ts` after every test. See the note above. */
export function restoreSocketStub(): void {
  active = null;
  install(PoisonedWebSocket);
}

export type StubTimer = {
  /** Hand this to `StreamProvider`'s `timer` prop. */
  schedule: StreamTimer;
  /** Every delay ever asked for, in order — the backoff curve, stated exactly. */
  delays: number[];
  /** How many timers are scheduled and neither fired nor cancelled. */
  readonly pending: number;
  /** Runs the earliest outstanding timer. Throws when there is none. */
  fire(): void;
};

/**
 * Backoff without waiting for it.
 *
 * A real `setTimeout` would make "does a 4401 stop reconnecting" a question you
 * answer by waiting long enough to be convinced, which is both slow and never
 * quite conclusive. Here it is `pending === 0`, immediately.
 */
export function createStubTimer(): StubTimer {
  const queued: Array<(() => void) | null> = [];
  const delays: number[] = [];

  return {
    schedule: (run, ms) => {
      const index = queued.length;
      queued.push(run);
      delays.push(ms);
      return () => {
        queued[index] = null;
      };
    },
    delays,
    get pending() {
      return queued.filter((run) => run !== null).length;
    },
    fire() {
      const index = queued.findIndex((run) => run !== null);
      const run = index === -1 ? undefined : queued[index];
      if (run === undefined || run === null) throw new Error("no timer is pending");
      queued[index] = null;
      run();
    },
  };
}
