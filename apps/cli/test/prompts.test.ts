import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { createPrompt, type PromptView, putSettings } from "@omni/control";
import { parse } from "../src/args.ts";
import { keysPrompts } from "../src/commands/keys.ts";
import { settingsSet } from "../src/commands/settings.ts";
import { CliError, createContext } from "../src/context.ts";
import { run } from "../src/run.ts";
import { capture, cli, fakeService, makeRoot, openStore, silentPrompt } from "./helpers/harness.ts";

test("assignment surplus positionals refuse before opening the store or calling effects", async () => {
  const root = makeRoot();
  for (const [command, argv] of [
    [keysPrompts, ["key-id", "PRIVATE SURPLUS", "--ids", "team", "--no-global"]],
    [settingsSet, ["prompts", "team", "PRIVATE SURPLUS"]],
  ] as const) {
    let effects = 0;
    const forbidden = () => {
      effects++;
      throw new Error("unexpected effect");
    };
    const captured = capture();
    const ctx = createContext(parse([]), { env: {}, cwd: root });
    await expect(
      command.run(parse(argv, command.options), {
        ctx: { ...ctx, store: forbidden },
        writer: captured.writer,
        prompt: silentPrompt,
        promptInput: { readFile: forbidden, readStdin: forbidden },
        setupFs: { homeDir: root, cwd: root, read: forbidden, write: forbidden },
        service: forbidden,
        connect: forbidden,
        connectable: forbidden,
        foreground: forbidden,
      }),
    ).rejects.toThrow("unexpected positional arguments");
    expect(effects).toBe(0);
    const result = await cli(
      command === keysPrompts ? ["keys", "prompts", ...argv] : ["settings", "set", ...argv],
      { root },
    );
    expect(result.code).toBe(2);
    expect(result.out + result.err).not.toContain("PRIVATE SURPLUS");
  }
});

test("prompt parser errors never echo dash-prefixed bodies or unknown options", async () => {
  const root = makeRoot();
  let effects = 0;
  const forbidden = async () => {
    effects++;
    throw new Error("unexpected input");
  };
  for (const args of [
    ["list"],
    ["show", "team"],
    ["create", "team", "--name", "Team"],
    ["save", "team"],
    ["activate", "team", "1"],
    ["duplicate", "team", "copy"],
    ["remove", "team"],
  ]) {
    const result = await cli(["prompts", ...args, "--PRIVATE-PROMPT-TEXT"], {
      root,
      promptInput: { readFile: forbidden, readStdin: forbidden },
    });
    expect(result.code).toBe(2);
    expect(result.err).toStartWith("invalid prompt command arguments\nusage: omni prompts ");
    expect(result.out + result.err).not.toContain("PRIVATE-PROMPT-TEXT");
    expect(result.out + result.err).not.toContain("Unknown option");
  }
  expect(effects).toBe(0);
});

function input(text: string) {
  return { readFile: async (_path: string) => text, readStdin: async () => text };
}

async function seed(root: string, id = "team", text = "private prompt body") {
  const store = await openStore(root);
  await createPrompt(store, { id, name: "Team rules", text });
  store.close();
}

test("create from injected file and stdin keeps leading whitespace, with trimEnd in control", async () => {
  const root = makeRoot();
  const text = " \t\n  exact literal {{name}}\n\t  ";
  for (const [id, flags] of [
    ["file", ["--file", "rules.txt"]],
    ["pipe", []],
    ["dash", ["--file", "-"]],
  ] as const) {
    const result = await cli(["prompts", "create", id, "--name", "Rules", ...flags, "--json"], {
      root,
      promptInput: {
        readFile: async (path) => {
          if (id !== "file") throw new Error("stdin command unexpectedly read a file");
          expect(path).toBe("rules.txt");
          return text;
        },
        readStdin: async () => {
          if (id === "file") throw new Error("file command unexpectedly read stdin");
          return text;
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.out + result.err).not.toContain("exact literal");
    expect(JSON.parse(result.out)).toMatchObject({ id, activeVersion: 1 });
    const store = await openStore(root);
    expect((await store.prompts.get(id))?.versions[0]?.text).toBe(text.trimEnd());
    store.close();
  }
});

test("draft, save, activate and rollback retain history and show only the exact requested version", async () => {
  const root = makeRoot();
  expect(
    (
      await cli(["prompts", "create", "team", "--name", "Team", "--draft"], {
        root,
        promptInput: input("  first\n"),
      })
    ).code,
  ).toBe(0);
  const store = await openStore(root);
  expect((await store.prompts.get("team"))?.activeVersion).toBeNull();
  expect(
    (
      await cli(["prompts", "save", "team", "--note", "revision", "--draft", "--json"], {
        root,
        promptInput: input("\tsecond\n"),
      })
    ).code,
  ).toBe(0);
  expect((await store.prompts.get("team"))?.activeVersion).toBeNull();
  expect((await cli(["prompts", "activate", "team", "2"], { root })).code).toBe(0);
  const saved = await cli(["prompts", "save", "team", "--json"], {
    root,
    promptInput: input("third"),
  });
  expect(saved.code).toBe(0);
  expect(JSON.parse(saved.out)).toMatchObject({ id: "team", version: 3, activeVersion: 3 });
  expect(saved.out).not.toContain("third");
  expect((await cli(["prompts", "activate", "team", "1"], { root })).code).toBe(0);
  expect((await store.prompts.get("team"))?.activeVersion).toBe(1);
  const shown = await cli(["prompts", "show", "team", "--version", "2", "--json"], { root });
  expect(shown.code).toBe(0);
  const body = JSON.parse(shown.out) as { prompt: PromptView };
  expect(body.prompt.versions).toEqual([
    expect.objectContaining({ version: 2, text: "\tsecond", note: "revision" }),
  ]);
  expect(shown.out).not.toContain("first");
  expect(shown.out).not.toContain("third");
  const current = await cli(["prompts", "show", "team"], { root });
  expect(current.out).toContain("  first");
  expect(current.out).not.toContain("second");
  expect((await cli(["prompts", "show", "team", "--version", "99"], { root })).code).toBe(1);
  store.close();
});

test("builtins list/show/duplicate, but refuse every mutation", async () => {
  const root = makeRoot();
  const listed = await cli(["prompts", "list", "--json"], { root });
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.out)).toMatchObject({
    prompts: [
      expect.objectContaining({ id: "ponytail-lite", builtin: true }),
      expect.objectContaining({ id: "ponytail-full", builtin: true }),
      expect.objectContaining({ id: "ponytail-ultra", builtin: true }),
    ],
  });
  const shown = await cli(["prompts", "show", "ponytail-lite", "--version", "v4.9.0", "--json"], {
    root,
  });
  expect(shown.code).toBe(0);
  const source = (JSON.parse(shown.out) as { prompt: PromptView }).prompt;
  const copied = await cli(["prompts", "duplicate", "ponytail-lite", "local", "--json"], { root });
  expect(copied.code).toBe(0);
  expect(JSON.parse(copied.out)).toMatchObject({ id: "local", name: source.name, builtin: false });
  const store = await openStore(root);
  expect((await store.prompts.get("local"))?.versions[0]?.text).toBe(
    source.versions[0]?.text.trimEnd(),
  );
  store.close();
  for (const args of [
    ["create", "ponytail-lite", "--name", "Bad"],
    ["save", "ponytail-lite"],
    ["activate", "ponytail-lite", "1"],
    ["remove", "ponytail-lite"],
  ]) {
    const result = await cli(["prompts", ...args], {
      root,
      promptInput: input("DO NOT ECHO THIS"),
    });
    expect(result.code).toBe(1);
    expect(result.out + result.err).not.toContain("DO NOT ECHO THIS");
  }
});

test("duplicate copies the active version or latest draft, with source name unless overridden", async () => {
  const root = makeRoot();
  await seed(root);
  const store = await openStore(root);
  await store.prompts.saveVersion("team", { text: "new draft", note: null, activate: false });
  const copied = await cli(["prompts", "duplicate", "team", "copy", "--name", "Custom", "--json"], {
    root,
  });
  expect(copied.code).toBe(0);
  expect(JSON.parse(copied.out)).toMatchObject({ name: "Custom" });
  expect((await store.prompts.get("copy"))?.versions[0]?.text).toBe("private prompt body");
  await store.prompts.create({
    id: "draft",
    name: "Draft",
    text: "latest draft",
    description: null,
    note: null,
    activate: false,
  });
  const draft = await cli(["prompts", "duplicate", "draft", "copy-draft", "--json"], { root });
  expect(draft.code).toBe(0);
  expect(JSON.parse(draft.out)).toMatchObject({ name: "Draft" });
  expect((await store.prompts.get("copy-draft"))?.versions[0]?.text).toBe("latest draft");
  store.close();
});

test("list exposes assignment IDs/counts without text; assigned deletion refuses until cleared", async () => {
  const root = makeRoot();
  await seed(root);
  const store = await openStore(root);
  await putSettings(store, { ...(await store.config.getSettings()), prompts: ["team"] });
  const created = await cli(["keys", "create", "--json"], { root });
  const { id: keyId } = JSON.parse(created.out) as { id: string };
  expect((await cli(["keys", "prompts", keyId, "--ids", "team"], { root })).code).toBe(0);
  const structured = await cli(["prompts", "list", "--json"], { root });
  const library = JSON.parse(structured.out) as { prompts: PromptView[] };
  expect(library.prompts.find((p) => p.id === "team")?.assignments).toEqual({
    global: true,
    keyIds: [keyId],
  });
  const list = await cli(["prompts", "list"], { root });
  expect(list.code).toBe(0);
  expect(list.out).toContain("team");
  expect(list.out).toContain("GLOBAL");
  expect(list.out).toContain("KEYS");
  expect(list.out).not.toContain("private prompt body");
  const removed = await cli(["prompts", "remove", "team"], { root });
  expect(removed.code).toBe(1);
  expect(removed.err).toContain("CONFLICT");
  expect(removed.err).toContain(keyId);
  expect((await cli(["settings", "set", "prompts", ""], { root })).code).toBe(0);
  expect((await cli(["prompts", "remove", "team"], { root })).code).toBe(1);
  expect((await cli(["keys", "prompts", keyId, "--ids", ""], { root })).code).toBe(0);
  const result = await cli(["prompts", "remove", "team", "--json"], { root });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({ id: "team", removed: true });
  expect(await store.prompts.get("team")).toBeNull();
  store.close();
});

test("versions accept only positive decimal integers (or the pinned builtin show version)", async () => {
  const root = makeRoot();
  await seed(root);
  for (const version of [
    "0",
    "-1",
    "1.1",
    "1e0",
    "0x1",
    "+1",
    " 1",
    "1x",
    "9007199254740992",
    "v4.9.0",
  ]) {
    for (const args of [
      ["activate", "team", version],
      ["show", "team", `--version=${version}`],
    ]) {
      const result = await cli(["prompts", ...args], { root });
      expect({ version, code: result.code }).toEqual({ version, code: 2 });
    }
  }
});

test("input failures and validation never echo text, including input error messages", async () => {
  const root = makeRoot();
  const secret = "TOP SECRET PROMPT TEXT";
  for (const args of [["--file", "missing"], [], ["--file", "-"]]) {
    const result = await cli(["prompts", "create", "team", "--name", "Team", ...args], {
      root,
      promptInput: {
        readFile: async () => {
          throw new Error(secret);
        },
        readStdin: async () => {
          throw new Error(secret);
        },
      },
    });
    expect(result.code).toBe(1);
    expect(result.out + result.err).not.toContain(secret);
    expect(result.err).toContain("read prompt");
  }
  for (const text of [" \n\t", secret.repeat(1000)]) {
    const result = await cli(["prompts", "create", "team", "--name", "Team", "--json"], {
      root,
      promptInput: input(text),
    });
    expect(result.code).toBe(1);
    expect(result.out + result.err).not.toContain(secret);
  }
  const tty = await cli(["prompts", "create", "team", "--name", "Team"], {
    root,
    promptInput: {
      ...input(""),
      readStdin: async () => {
        throw new CliError("provide --file or pipe prompt text");
      },
    },
  });
  expect(tty.code).toBe(1);
  expect(tty.err).toContain("provide --file or pipe prompt text");
});

test("required file/name flags fail before reading input and surplus body argv is refused without echo", async () => {
  const root = makeRoot();
  for (const args of [
    ["create", "team"],
    ["create", "team", "--name"],
    ["create", "team", "--name", "Team", "--file"],
    ["create", "team", "--name", "Team", "PRIVATE BODY IN ARGV"],
  ]) {
    const result = await cli(["prompts", ...args], { root });
    expect(result.code).toBe(2);
    expect(result.err).not.toContain("PRIVATE BODY IN ARGV");
  }
});

test("prompt help needs no installation, input, provider or process effects", async () => {
  const captured = capture();
  expect(await run(["prompts", "--help"], captured.writer, { env: {}, cwd: "/nonexistent" })).toBe(
    0,
  );
  const help = captured.out.join("\n");
  for (const verb of ["list", "show", "create", "save", "activate", "duplicate", "remove"])
    expect(help).toContain(`prompts ${verb}`);
  expect(help).toContain("--file");
  const root = makeRoot();
  const service = fakeService({ root });
  const result = await cli(["prompts", "create", "team", "--name", "Team"], {
    root,
    service,
    promptInput: input("local only"),
    connect: () => {
      throw new Error("provider access forbidden");
    },
    foreground: async () => {
      throw new Error("spawn forbidden");
    },
  });
  expect(result.code).toBe(0);
  expect(service.commands).toEqual([]);
  expect(service.spawned).toEqual([]);
});

test("runtime refuses interactive stdin for omitted --file and --file - without waiting", async () => {
  const root = makeRoot();
  for (const flags of [[], ["--file", "-"]]) {
    const captured = capture();
    const code = await run(
      ["--root", root, "prompts", "create", "team", "--name", "Team", ...flags],
      captured.writer,
      {
        env: {},
        cwd: root,
        prompt: {
          isTty: true,
          secret: async () => {
            throw new Error("secret input must not be used");
          },
          confirm: async () => true,
        },
      },
    );
    expect(code).toBe(1);
    expect(captured.err.join("\n")).toContain("provide --file or pipe prompt text");
  }
});

test("unexpected storage failures cannot echo prompt text", async () => {
  const root = makeRoot();
  await seed(root);
  const db = new Database(join(root, "omnigateway.db"));
  db.exec(
    "CREATE TRIGGER fail_prompt_save BEFORE INSERT ON prompt_versions BEGIN SELECT RAISE(ABORT, 'PRIVATE STORAGE PROMPT TEXT'); END",
  );
  db.close();
  const result = await cli(["prompts", "save", "team"], {
    root,
    promptInput: input("PRIVATE STORAGE PROMPT TEXT"),
  });
  expect(result.code).toBe(1);
  expect(result.out + result.err).not.toContain("PRIVATE STORAGE PROMPT TEXT");
  expect(result.err).toContain("prompt operation failed");
});
