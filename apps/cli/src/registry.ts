import type { Command } from "./command.ts";
import { bodies } from "./commands/bodies.ts";
import { connect } from "./commands/connect.ts";
import { console_ } from "./commands/console.ts";
import {
  credentialsAddKey,
  credentialsDisable,
  credentialsEnable,
  credentialsHealth,
  credentialsList,
  credentialsRefresh,
  credentialsRemove,
  credentialsSet,
  credentialsShow,
} from "./commands/credentials.ts";
import { dbBackup, dbMigrate, dbRestore, dbSnapshots, dbStats, dbVacuum } from "./commands/db.ts";
import { keysCreate, keysLimits, keysList, keysModels, keysRevoke } from "./commands/keys.ts";
import {
  modelsCatalog,
  modelsDryRun,
  modelsList,
  modelsPut,
  modelsRemove,
  modelsShow,
} from "./commands/models.ts";
import {
  pluginInstall,
  pluginList,
  pluginRemove,
  pluginUpdate,
  pluginVerify,
} from "./commands/plugins.ts";
import { quota } from "./commands/quota.ts";
import {
  doctor,
  restart,
  serviceInstall,
  serviceUninstall,
  start,
  stop,
} from "./commands/service.ts";
import { settingsGet, settingsSet } from "./commands/settings.ts";
import { setupClaude, setupOpencode } from "./commands/setup.ts";
import { adminSetPassword, status } from "./commands/status.ts";
import { logs, usage } from "./commands/usage.ts";

/**
 * Every command, keyed by the words that select it.
 *
 * Longest match wins, so `credentials list` beats a hypothetical `credentials`,
 * and what follows the match is that command's own positionals.
 */
export const COMMANDS: Readonly<Record<string, Command>> = {
  status,
  start,
  stop,
  restart,
  doctor,
  logs,
  bodies,
  console: console_,
  usage,
  quota,
  connect,

  "service install": serviceInstall,
  "service uninstall": serviceUninstall,

  "credentials list": credentialsList,
  "credentials show": credentialsShow,
  "credentials enable": credentialsEnable,
  "credentials disable": credentialsDisable,
  "credentials set": credentialsSet,
  "credentials rm": credentialsRemove,
  "credentials refresh": credentialsRefresh,
  "credentials add-key": credentialsAddKey,
  "credentials health": credentialsHealth,

  "models list": modelsList,
  "models show": modelsShow,
  "models put": modelsPut,
  "models rm": modelsRemove,
  "models dry-run": modelsDryRun,
  "models catalog": modelsCatalog,

  "keys list": keysList,
  "keys create": keysCreate,
  "keys limits": keysLimits,
  "keys models": keysModels,
  "keys revoke": keysRevoke,

  "plugin list": pluginList,
  "plugin verify": pluginVerify,
  "plugin install": pluginInstall,
  "plugin update": pluginUpdate,
  "plugin remove": pluginRemove,

  "settings get": settingsGet,
  "settings set": settingsSet,

  "setup claude": setupClaude,
  "setup opencode": setupOpencode,

  "admin set-password": adminSetPassword,

  "db migrate": dbMigrate,
  "db stats": dbStats,
  "db snapshots": dbSnapshots,
  "db backup": dbBackup,
  "db restore": dbRestore,
  "db vacuum": dbVacuum,
};

export type Resolved = { name: string; command: Command; rest: string[] };

/** Global flags that take a value, so their argument is not mistaken for a verb. */
const VALUED_GLOBALS = new Set(["--root", "--db"]);

/**
 * Picks the command out of an argv.
 *
 * Global flags may come first (`omni --root /srv status`), so leading flags are
 * stepped over — taking their value with them — before the verb is read. After
 * that the command words must be adjacent, which is what keeps
 * `omni credentials set c1 --label x` free of guesswork about whether `c1`
 * belongs to the path or to `--label`.
 */
export function resolveCommand(argv: readonly string[]): Resolved | null {
  const leading: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("-")) break;
    leading.push(token);
    index += 1;
    if (VALUED_GLOBALS.has(token) && argv[index] !== undefined) {
      leading.push(argv[index] as string);
      index += 1;
    }
  }

  const words: string[] = [];
  for (const token of argv.slice(index)) {
    if (token.startsWith("-")) break;
    words.push(token);
    if (words.length === 3) break;
  }

  for (let length = Math.min(words.length, 3); length > 0; length--) {
    const name = words.slice(0, length).join(" ");
    const command = COMMANDS[name];
    if (command !== undefined) {
      return { name, command, rest: [...leading, ...argv.slice(index + length)] };
    }
  }
  return null;
}
