/** Explicit output file is flushed before SQLite; stdout is buffered until exit. */
export async function readOhaReport<T>(
  file: string,
  exited: Promise<number>,
  ready: (report: T) => void,
): Promise<T> {
  let ended = false;
  void exited.then(() => {
    ended = true;
  });
  for (;;) {
    let report: T | undefined;
    try {
      report = await Bun.file(file).json();
    } catch {}
    if (report !== undefined) {
      ready(report);
      return report;
    }
    if (ended) throw Error("oha exited without complete report");
    await Bun.sleep(2);
  }
}
