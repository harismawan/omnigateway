import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { RestoreResult } from "../../api/types.ts";
import { endAdminSession } from "../../session/reasons.ts";

/**
 * What the console does once the database has been replaced.
 *
 * Shared by restore and import because they are one operation with two sources,
 * and the two endings must not drift apart.
 *
 * The ordinary ending clears the whole cache rather than the database key: every
 * screen in this console reads from the file that has just been swapped, so the
 * credentials, models, keys and logs held in memory describe a database that no
 * longer exists.
 *
 * The other ending is `adminPasswordChanged`. By the time that reaches here the
 * gateway has already ended every admin session, so the cookie this tab holds is
 * dead and a refetch would only collect a 401 per screen. The operator goes to
 * the login screen instead, told why.
 */
export function useApplyRestore(): (result: RestoreResult) => void {
  const client = useQueryClient();
  return useCallback(
    (result: RestoreResult) => {
      if (result.adminPasswordChanged) {
        endAdminSession("admin-password-changed");
        return;
      }
      void client.invalidateQueries();
    },
    [client],
  );
}
