import { COMMANDS } from "./registry.ts";

const GROUPS: ReadonlyArray<{ title: string; prefixes: readonly string[] }> = [
  {
    title: "Gateway",
    prefixes: ["status", "start", "stop", "restart", "doctor", "logs", "bodies", "console"],
  },
  { title: "Service", prefixes: ["service "] },
  { title: "Accounts", prefixes: ["connect", "credentials "] },
  { title: "Models", prefixes: ["models "] },
  { title: "Keys", prefixes: ["keys "] },
  { title: "Configuration", prefixes: ["settings ", "admin ", "db "] },
  { title: "Reports", prefixes: ["usage", "quota"] },
];

function matches(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) =>
    prefix.endsWith(" ") ? name.startsWith(prefix) : name === prefix,
  );
}

export function helpText(): string {
  const lines: string[] = [
    "omni — manage a local OmniGateway installation",
    "",
    "Usage: omni <command> [options]",
    "",
    "Global options:",
    "  --root <path>   installation to manage (default: $OMNI_ROOT, cwd, ~/.config/omnigateway)",
    "  --db <path>     database file, overriding OMNI_DB_PATH",
    "  --json          emit JSON instead of tables",
    "  --no-color      never colourise output",
    "  --yes, -y       answer confirmations without asking",
    "  --system        act on the system systemd unit rather than the user one",
    "  --help, -h      show this help",
    "",
  ];

  for (const group of GROUPS) {
    const entries = Object.entries(COMMANDS).filter(([name]) => matches(name, group.prefixes));
    if (entries.length === 0) continue;

    // Padded per group rather than globally: one long usage line should not
    // push every other summary halfway across the terminal.
    const width = entries.reduce((max, [, c]) => Math.max(max, c.usage.length), 0);
    lines.push(`${group.title}:`);
    for (const [, command] of entries) {
      lines.push(`  ${command.usage.padEnd(width)}  ${command.summary}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function commandHelp(name: string): string {
  const command = COMMANDS[name];
  if (command === undefined) return helpText();
  return [`omni ${command.usage}`, "", command.summary].join("\n");
}
