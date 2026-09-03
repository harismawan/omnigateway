# Installing and managing plugins

Operator detail behind the `omni plugin …` commands: how a spec is resolved, what
`install` refuses and why, what `list` and `verify` report, and what `remove`
keeps. The short version — install, verify, restart, and the security note — is
in the [README](../README.md#plugins). To write one, see
[writing-a-plugin.md](writing-a-plugin.md).

## Installing

```bash
omni plugin install ./some-plugin     # a directory, or a .tgz
omni plugin install https://…/x.tgz   # a tarball over https, never http
omni plugin install some-plugin@1.2.3 # a package name, through the npm registry
omni plugin verify some-plugin        # every check the next boot will run
omni plugin list                      # what is installed, and whether it would load
omni plugin update some-plugin        # reinstall from whatever it was installed from
omni restart                          # plugins load at boot, so this is required
```

`update` needs no spec: `install` records the one you typed in
`.omni-install.json` beside the plugin, so picking up a patch release is the
plugin's id and nothing else. A bare package name re-resolves to the current
release; `name@1.2.3` reinstalls that version exactly. A plugin copied in by
hand has no record and `update` says so rather than guessing.

**Nothing in the package is executed by any of these.** There is no dependency
resolution, no `node_modules`, and no lifecycle script — the installer fetches,
checks, and unpacks, and the plugin's own code is first imported at the next boot.

A spec is resolved filesystem-first: directory, then local tarball, then URL,
then registry. That order is the safe one. The reverse would let a published
package shadow the directory you are standing in and turn `omni plugin install
some-plugin` into a download nobody asked for.

Installing by name refuses more than it accepts, and each refusal happens before
any bytes are fetched: the tarball must be served from the registry's own host,
the registry must advertise an integrity hash or a shasum, and only an exact
version or the registry's `latest` resolves — no ranges, no other dist-tags. Use
`--registry` (or `OMNI_PLUGIN_REGISTRY`) for a private registry; it must be
`https://`.

A URL you type is different, and the difference is the point: nothing downstream
has a digest to check it against, so TLS to the host you named is the only
assurance there is. That is why `http://` is refused rather than upgraded.

## What `list` and `verify` report

`omni plugin list` prints what this installation has — id, name, version, the
plugin API and console SDK it was built against, the capabilities it declared,
and whether the gateway would load it:

```
ID       NAME               VERSION  API  SDK     CAPABILITIES                    STATE
pokemon  Pokémon Companion  1.0.0    2    ^1.0.0  storage,files,net:outbound,…    ok
```

The API column is the plugin API generation, and it is matched **exactly** — a
plugin built against an older one is listed with that as its reason rather than
loaded.

The capabilities a manifest may declare are `storage`, `files`, `net:outbound`,
`events:request`, `events:limit`, `channels` and `provider`. `channels` is
namespaced topics on the gateway's push socket, which a plugin owns without ever
touching a connection. `provider` lets a plugin supply a provider of its own —
the models, the wire format, and optionally the OAuth flow, so
`omni connect <plugin-id>` works for it exactly as it does for a built-in.
Anything a plugin did not declare is absent from what it is handed.

`net:outbound` and `provider` each require the manifest to declare `origins`,
and both are enforced: a plugin's own `fetch` and the requests the gateway makes
on a provider plugin's behalf are both refused outside them. That is what makes
`omni plugin verify <id>` worth reading before you install one — where your
prompts can be sent is in the manifest, not only in the code.

A plugin that would *not* load is listed with the reason rather than hidden,
because a plugin missing from the console is exactly what you are trying to
explain. For one plugin's full detail — its entry points and the outbound
origins it declared — use `omni plugin verify <id>`.

`verify` is the one to run before restarting a gateway that people are using: it
reaches the same verdict the next boot will, from the same code, without loading
the plugin.

## Where plugins come from

There is no curated directory to browse, and there is no plan for one. A plugin
is a directory, a tarball, a URL or a package name you point `omni plugin
install` at, and you are expected to know where it came from — see the
[security note](../README.md#security) for why that is the model rather than an omission.

Resolving a name through npm makes distribution easier; it does not make an
unknown plugin safer. Integrity checking proves you received the bytes the
registry advertised, and nothing about who wrote them or what they do once the
gateway imports them.

None ship in this repository, deliberately. The first one did, and moving it out
is what proved the plugin API actually works from outside: while it built as a
workspace sibling it could reach internal packages no published plugin can, and
two bugs hid in exactly that gap.

### Installing on a machine with no checkout

A published plugin installs by name — no checkout, no build toolchain:

```bash
omni plugin install omnigateway-plugin-example
omni plugin verify example && omni restart
```

Building and shipping your own plugin — tarball layout, the manifest-at-root
rule, why plaintext `http://` stays refused, Docker mounting — is covered in
[writing-a-plugin.md](writing-a-plugin.md).

**In Docker**, mount the plugin at `<root>/plugins/<id>` on a volume — the same
layout `install` writes — and restart the container; read-write, not `:ro`,
because a plugin declaring `files` writes its cache inside its own directory.

## Removing

Removing one keeps its data:

```bash
omni plugin remove some-plugin          # directory goes, database tables stay
omni plugin remove some-plugin --purge  # tables too, after confirming
```

That default is deliberate. A plugin directory can be reinstalled from the
package it came from; whatever it accumulated in your database cannot be
reinstalled from anything.

Note what "directory goes" includes: a plugin's `data/` directory is removed
with it. That directory holds cached files a plugin can rebuild — it is excluded
from [snapshots](operations.md#snapshots-and-restore) for that reason, so it has no restore
path and is not meant to need one. Only the database tables are kept, and only
those are what `--purge` additionally drops. For the same reason, restoring a snapshot onto an
installation that no longer has a plugin leaves that plugin's tables in place —
`omni doctor` reports them, and nothing removes them for you.
