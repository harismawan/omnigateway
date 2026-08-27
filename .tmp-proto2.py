"""Restore the plain literal shape and null the prototype after it.

`Object.assign(Object.create(null), {...})` re-indented the entries and changed
the terminator, which broke `packages/dashboard-sdk/test/theme.test.ts` — it
reads this file as *text* because it may not import `@omni/providers`. The
literal is the shape other tools expect, so keep it and drop the prototype on
the next line.
"""

import re

SITES = [
    ("packages/providers/src/descriptors.ts", "PROVIDER_DESCRIPTORS", "ProviderDescriptors"),
    (
        "packages/providers/src/catalog.ts",
        "PROVIDER_MODEL_CATALOG",
        "Readonly<Record<string, ProviderModelCatalogEntry>>",
    ),
    ("packages/providers/src/profile.ts", "PROFILES", "Readonly<Record<string, ClientProfile>>"),
    (
        "packages/providers/src/body.ts",
        "BODY_ORDER",
        "Readonly<Record<string, readonly string[]>>",
    ),
    ("packages/providers/src/registry.ts", "ADAPTERS", "Readonly<Record<string, ProviderAdapter>>"),
]

NOTE = {
    "PROVIDER_DESCRIPTORS": """// Nothing to inherit, and this is load-bearing rather than tidy.
//
// A provider id arrives from a client's `model` name and from unvalidated JSON
// in `virtual_models.targets`. On an ordinary object literal
// `table["constructor"]` answers the `Object` constructor, so every
// `!== undefined` and `?.` guard in the codebase reads "that provider exists"
// and then throws on the next property access — `model: "constructor/foo"`
// reached the client as a 500 carrying an internal source expression.
//
// `noUncheckedIndexedAccess` cannot see this: it forces a guard, and the guard
// it forces is the one a prototype key defeats. Fixing each reader would leave
// the next to rediscover it, and would cover only the readers that ask an
// existence question — not `catalogPricing`'s `?.`. One invariant covers every
// reader of every table below. Pinned by `descriptor.test.ts`.""",
}
DEFAULT_NOTE = "// Nothing to inherit; see the note on `PROVIDER_DESCRIPTORS`."

for path, name, annotation in SITES:
    src = open(path).read()
    start = src.index(f"export const {name}")
    end = src.index("\n);", start) + len("\n);")
    block = src[start:end]

    entries = re.findall(r"^ {4}(\w+): (\w+),$", block, re.M)
    if not entries:
        raise SystemExit(f"no entries found in {path}")

    lines = "\n".join(f"  {key}: {value}," for key, value in entries)
    note = NOTE.get(name, DEFAULT_NOTE)
    rebuilt = (
        f"export const {name}: {annotation} = {{\n{lines}\n}};\n\n"
        + note
        + f"\nObject.setPrototypeOf({name}, null);"
    )
    open(path, "w").write(src[:start] + rebuilt + src[end:])
    print("rewrote", path, f"({len(entries)} entries)")
