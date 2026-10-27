import type { ProviderId } from "@omni/ir";
import type { BodyPublication } from "@omni/store/types";

export const BODY_SLICE_BYTES = 1024 * 1024;
export const BODY_QUEUE_LIMIT = 1000;
export type BodyWriterInit = {
  databasePath: string | null;
  databaseUrl: string | null;
  encryptionKey: string;
};
export type BodyPart = string;
export type BodyMeta = {
  type: "meta";
  requestId: string;
  generation: number;
  at: number;
  error: unknown;
  client: { truncated: boolean; responseFrames: boolean };
  attempts: Array<{
    attempt: number;
    provider: ProviderId;
    truncated: boolean;
    streamChunks: boolean;
  }>;
  abandoned: "budget" | "backlog" | null;
};
export type MainMessage =
  | {
      type: "part";
      requestId: string;
      generation: number;
      part: BodyPart;
      seq: number;
      last: boolean;
      bytes: ArrayBuffer;
    }
  | BodyMeta
  | { type: "publish-ok"; requestId: string; relPath: string }
  | { type: "publish-result"; requestId: string; accepted: boolean }
  | { type: "pause" | "resume" | "stop" };
export type WorkerMessage =
  | { type: "slice-ack"; requestId: string; generation: number; bytes: number }
  | { type: "publishing"; requestId: string; generation: number; relPath: string }
  | ({ type: "written"; generation: number } & BodyPublication)
  | { type: "write-failed"; requestId: string; generation: number }
  | { type: "cleaned"; requestId: string; generation: number }
  | { type: "discarded"; requestId: string; generation: number }
  | { type: "unowned"; requestId: string; generation: number }
  | { type: "paused" };
