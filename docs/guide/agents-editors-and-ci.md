# Agents, editors and CI

**folio check** - prints the folder's health, one problem a line, and exits 1 when one of them is an error, so it can gate a commit or a CI run. It asks the Folio serving the folder when one is running, and otherwise works the health out itself.

```text
$ folio check
report.md:3          -      figure   9.4 is contradicted: the data says 8.9 (#totals#0.temp_c)
notes/uplink.md:3    -      link     Links to notes/antenna.md, which is not there
notes/uplink.md:5    -      include  Includes parts/frequencies.md, which is not there
stations/west.md:5   -      field    calibrated: before the storms is not a date
stations/south.md:1  error  rule     An active station has no owner
folio check: 1 error, 4 other problems
```

**Agents** - `folio mcp` is an MCP server whose tools read the Folio serving the agent's folder: documents and their blocks, queries, health, what changed, history, what you have read and what you are looking at. An agent's MCP client starts it as a command:

```json
{ "mcpServers": { "folio": { "command": "folio", "args": ["mcp"] } } }
```

`folio mcp localhost:8641` or `folio mcp /run/folio.sock` names the Folio to read instead. In Claude Code, the folio plugin installs the server and the agent skill below, and runs the Folio release it pins through `npx`, so Node.js is all it needs:

```sh
claude plugin marketplace add jakubro/folio
claude plugin install folio@folio
```

The plugin's Folio setting, in `/config`, names a Folio by its address or socket; left empty, the tools read the Folio serving the folder Claude Code is opened in.

The same answers are JSON over HTTP at `?api=`, as in `curl 'http://localhost:8640/?api=health'`, and `--socket` also serves them on a unix socket, for an agent in a container that shares the folder. The button on the front page pauses sharing what you read and look at.

**An agent that writes for Folio** - [`plugin/skills/folio`](../../plugin/skills/folio/SKILL.md) in Folio's repository is an agent skill. It teaches an agent to write documents that use everything the guide covers - includes, block links, embedded data, queries, checked figures, saved views and `FOLIO.md` declarations - and to check its work with `folio check`. The folio plugin brings it to Claude Code as `/folio:folio`; for another agent, copy the folder into its skills folder.

**Editors** - `folio lsp FOLDER` is a language server for any editor with an LSP client: broken links, missing includes and contradicted figures as you type, go to and references for headings and blocks, a block's provenance on hover, and, on renaming a heading or moving a file, the edits for every link to it.
