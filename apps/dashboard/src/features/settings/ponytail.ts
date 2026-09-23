import type { PonytailMode } from "../../api/types.ts";

/**
 * The ponytail levels, in the order an operator escalates through them.
 *
 * A `Record` over the union rather than a list: adding a level upstream then
 * fails this build instead of quietly offering one fewer option than exists.
 * Its own module because the settings board and the model editor both offer
 * it, and a route importing another route's board pulls that whole board in.
 */
export const PONYTAIL_LEVELS: Record<PonytailMode, string> = {
  off: "Off",
  lite: "Lite — names the lazier option",
  full: "Full — the ladder enforced",
  ultra: "Ultra — challenges the requirement",
};
