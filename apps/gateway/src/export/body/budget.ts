/** Whole-artifact admission shared by every destination in one worker. */
export function reservationBytes(ciphertext: number, plaintext: number, segment: number): number {
  return ciphertext + 3 * plaintext + segment;
}

/**
 * Cover actual allocations, not just retained payload counters. E includes
 * legacy hex (decoded UTF-16 plus unhex/decrypt), P includes expanded UTF-8,
 * UTF-16 source/client copies and packed scanner stack. Encoding trials can
 * escape each input byte sixfold; OTLP nests the inline record once more.
 * S is knowably bounded by client size, not an unused receiver maximum.
 * gzip's deflate bound + native workspace have explicit headroom.
 */
export function pipelineReservation(
  encrypted: number,
  plain: number,
  cap: number,
  metadata: number,
): number {
  const trial = Math.min(cap, 6 * plain + 4 * metadata + 4096);
  const decode = 8 * encrypted + Math.ceil(8 * plain) + 65536;
  const encode = 32 * plain + 12 * trial + 1024 * 1024 + 8 * metadata;
  return Math.max(decode, encode);
}

export type BodySlot = {
  reserve(bytes: number): boolean;
  shrink(bytes: number): void;
  release(): void;
};

export function createBodyBudget(limitBytes: number) {
  let held = 0;
  let busy = false;
  const queue: Array<() => void> = [];
  const release = () => {
    held = 0;
    const next = queue.shift();
    if (next) next();
    else busy = false;
  };
  return {
    held: () => held,
    async acquire(signal: AbortSignal): Promise<BodySlot> {
      signal.throwIfAborted();
      if (busy) {
        await new Promise<void>((resolve, reject) => {
          const ready = () => {
            signal.removeEventListener("abort", cancel);
            resolve();
          };
          const cancel = () => {
            const index = queue.indexOf(ready);
            if (index >= 0) queue.splice(index, 1);
            reject(signal.reason);
          };
          queue.push(ready);
          signal.addEventListener("abort", cancel, { once: true });
        });
      } else busy = true;
      if (signal.aborted) {
        release();
        signal.throwIfAborted();
      }
      let released = false;
      return {
        reserve(bytes) {
          if (released || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > limitBytes)
            return false;
          held = bytes;
          return true;
        },
        shrink(bytes) {
          if (!released) held = Math.max(0, Math.min(held, bytes));
        },
        release() {
          if (released) return;
          released = true;
          release();
        },
      };
    },
  };
}
