import { expect, test } from "bun:test";

/**
 * No database file is tracked by git.
 *
 * One reached a commit: a route test exercised `POST /api/database/snapshots`
 * as the operator, the handler wrote `snapshots/db_….sqlite` into the working
 * tree, and `git add -A` swept it into the branch. Its contents were synthetic —
 * three fixture keys, no credentials — but a snapshot is the one artifact that
 * carries encrypted provider credentials and API-key hashes on a real
 * installation, so the shape of the mistake is worse than that instance.
 *
 * `.gitignore` had `*.db` and not `*.sqlite`, which is the whole reason it
 * slipped: the rule existed and did not cover the extension the tests use.
 * Asserted against the index rather than the working tree, because ignoring a
 * file does nothing about one that is already tracked.
 */
test("no database or snapshot file is tracked", async () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: new URL("../../..", import.meta.url).pathname,
  });
  const tracked = new TextDecoder().decode(listed.stdout).split("\0").filter(Boolean);

  // Asserted first: an empty listing is also what a broken spawn reports, and
  // it would make the real assertion below pass for the wrong reason.
  expect(tracked.length).toBeGreaterThan(100);

  const databases = tracked.filter(
    (path) => /\.(sqlite|db)(-wal|-shm)?$/.test(path) || path.startsWith("snapshots/"),
  );
  expect(databases).toEqual([]);
});
