---
name: folio
description: Write markdown that uses everything folio adds, for a folder folio serves - documents assembled from other documents' files, sections and blocks; links to any block; data files embedded as tables, inline values and Vega-Lite charts; SQL queries over the folder's data files and over its own documents; figures in prose checked against their data; query results saved into the markdown; and the folder's kinds of documents, fields, rules, health, attention, staleness and digests declared in FOLIO.md. Use when writing or editing documents in a folder folio serves, when a FOLIO.md sits in the folder or above it, or when asked to make documents live, data-backed or self-checking.
---

# Writing for folio

folio serves a folder of markdown to the browser and keeps a model of the whole folder: every block of every document, the data files they read, what links to and includes what, and what the reader has read. A document written for folio is assembled from the documents that own its parts, computes its numbers from the folder's data, checks the figures its prose quotes, and keeps its lists current by querying the folder. Write that way in any folder folio serves:

- **Never copy a number out of data.** Embed it with `{value: ...}`, or tie the figure you type to its data with `<data value="...">`.
- **Never paste text another document owns.** Include its file, section or block.
- **Never keep a list by hand that a query can produce.** Query the data files, or the documents themselves.
- **Never describe in prose what a chart can show.** Draw it from the data.
- **Link to the exact block**, not to the page around it.
- **Give every recurring kind of document its fields and rules** in a `FOLIO.md`, so the folder checks itself.

In the raw text of this skill every include example carries a backslash before its brace, so folio does not resolve the examples when it serves these files. Write includes without the backslash.

Declaring a folder's conventions in `FOLIO.md`: [references/conventions.md](references/conventions.md). Every limit and edge case: [folio's reference](https://jakubro.github.io/folio/reference/).

## Find folio

A folio serving the folder answers on port 8640 unless it was started with another `--port`:

```sh
curl -s 'http://localhost:8640/?api=health'
```

The same answers come as read-only tools from folio's MCP server, which an agent starts as a command - `"args": ["mcp", "--port", "N"]` for another port:

```json
{ "mcpServers": { "folio": { "command": "folio", "args": ["mcp"] } } }
```

Without a running folio, `folio check FOLDER` still works out the folder's health on its own.

Before writing into a folder, read what it declares: every `FOLIO.md` in the folder and the folders above it. `?conventions` on an existing document names its kind and the fields it reads; for a document not written yet, `?api=kinds` on its path lists the kinds, rules and health entries applying there, each kind with the `where` patterns that place a document in it.

```sh
curl -s 'http://localhost:8640/stations/north.md?conventions'
curl -s 'http://localhost:8640/stations/west.md?api=kinds'
```

## Assemble from other documents

````markdown
\{include: parts/intro.md}

\{include: design.md#retry-policy}

\{include: design.md#^3f9a1c2e}
````

- A whole file, the section under a heading by its anchor - up to the next heading of the same or a higher level - or one block by its id.
- The path resolves against the including file's folder, or the served folder when it starts with `/`. It holds no brackets, braces, quotes or commas.
- Includes expand everywhere - prose, inline code, code blocks and diagram fences - and at any depth. A `mermaid` fence holding only `\{include: network.mmd}` draws that file's diagram, and a document may include a section of itself.
- The page updates when an included file is saved. An include that finds nothing stays as written, marked red, and is listed in health.
- `\\{include: path}` shows the include as text, never resolved.

## Link to headings and blocks

- Headings take GitHub's anchors: `[retry policy](design.md#retry-policy)`.
- Every block has an id, the ¶ in its margin: `[the threshold](design.md#^3f9a1c2e)`. A block link keeps landing on its block while the block is reworded or moved. A block id is 8 hex characters folio derives - never invent one. Save the file, then read the ids from its blocks; until folio has read a document just saved, this answers 503, so ask again:

```sh
curl -s 'http://localhost:8640/design.md?api=document'
```

- Backlinks are automatic: every page lists the documents linking to it, with the words around each link. Never keep a list of the pages pointing back.
- Link straight to data files and query files - each opens as a page - and to one table of a database: `[readings](data/archive.sqlite?table=readings)`.

## Put data in the document

CSV, TSV, JSON Lines, Parquet, JSON, YAML, SQLite and DuckDB files open as pages and embed into documents. A reference names what to read:

| Reference | Reads |
|---|---|
| `data/daily.csv` | The whole file; a tabular file's data is its list of rows |
| `data/daily.csv#0.rain_mm` | A part: keys, and row or list positions from 0, joined by dots |
| `data/stations.json#north.elevation_m` | A key path into nested data |
| `data/archive.sqlite#readings` | A database's table |
| `queries/wettest.sql` | A query file's result |
| `#totals` | The result of the query named `totals` in the same document |
| `#totals#0.rain_mm` | A part of that result |

A path resolves against the document's folder, or the served folder when it starts with `/`.

````markdown
{table: queries/wettest.sql}

The network logged {value: #totals#0.rain_mm | ,.1f} mm of rain, <data value="#totals#0.wet_days">9</data> days of it wet.

```vega-lite
mark: line
data: {url: data/daily.csv}
encoding:
  x: {field: day, type: temporal}
  y: {field: rain_mm, type: quantitative}
```
````

- **Table** - `{table: ref}` alone in a paragraph or list item, at any depth. The reader sorts, filters, hides columns and folds it.
- **Value** - `{value: ref}` anywhere in a paragraph, heading, list item or table cell, outside code. A space, `|`, a space and a [d3-format](https://d3js.org/d3-format) specifier format a number: `{value: ref | .1%}`, `{value: ref | ,.0f}`.
- **Figure** - `<data value="ref">48.2</data>` keeps the typed figure in the text and checks it against the data. A number matches within half a unit of its last typed digit; thousands separators, a sign, a currency mark and `k`, `K`, `M`, `B` or `bn` are allowed, and a figure ending in `%` reads a data value between -1 and 1 as a fraction. A date matches on the parts typed. A range such as `29-56%` is not checked, and health never lists it. Keep units outside the tag. A contradicted figure is underlined red with the data's value beside it and listed in health.
- **Chart** - a `vega-lite` fence holding a Vega-Lite description in JSON or YAML; every `data.url`, at any depth, is a reference. In YAML, quote a reference starting with `#` - unquoted, it is a comment.

Use a value where the sentence should always carry the data's current number, and a figure where the number belongs to the prose and must stay true. Every embed, chart and query result redraws on each open page when a file it reads changes. One whose file or part is missing shows the reference and why, marked red, and the rest of the page draws.

## Query the folder

A `sql query` fence runs one DuckDB `SELECT` from the document's folder and shows its result below the fence; a plain `sql` fence stays code. A name after `query` makes the result a reference, `#name`, for embeds, charts, figures and saved views of the same document - not for another query, which reads a shared query from its `.sql` file instead:

````markdown
```sql query totals
select round(sum(rain_mm), 1) as rain_mm, count(*) filter (where rain_mm > 0) as wet_days
from 'data/daily.csv'
```
````

- **Files** - a path in quotes is a table: `'data/daily.csv'`, `'data/archive.sqlite#readings'`, or `'queries/wettest.sql'` for another query's result. `read_csv`, `read_json`, `read_ndjson`, `read_parquet` and their variants read the folder's files named in quotes.
- **Patterns** - `*` and `?` match within one folder, `**` across folders: `'logs/**/*.jsonl'` reads every match, thousands as readily as two, stacked by column name, with each row's file in a `filename` column. A pattern matching nothing is an empty table, and a file matching later is picked up.
- **Query files** - a `.sql` file holds one query, opens as a page showing its text and result, and is used by its path wherever a reference goes.
- **Documents** - the folder's documents are tables too, with nothing to declare. Content an include brings in counts in the file holding it.

| Table | Columns |
|---|---|
| `folio.documents` | `path`, `title` (the first heading), `kind` |
| `folio.headings` | `path`, `line`, `level`, `text`, `anchor` |
| `folio.links` | `path`, `line`, `url` (as written), `target`, `fragment`, `context` |
| `folio.tasks` | `path`, `line`, `done`, `text` |
| `folio.frontmatter` | `path`, `key`, `value` |
| `folio.tables` | `path`, `line`, `row`, `header`, `cells` |
| `kind.<name>` | `path` and a column per field the kind declares |

````markdown
```sql query open
select t.path, t.line, t.text
from folio.tasks t
where not t.done
order by t.path, t.line
```
````

- **Limits** - one `SELECT`. `PIVOT`, `COPY`, `ATTACH`, anything writing a file, a path outside the served folder and a web address are refused; among table functions only the readers above, `range`, `generate_series` and `unnest` run. A query stops after 10 seconds, and a result keeps its first 10,000 rows and 16 MB.

Run a query or resolve a reference before writing it into a document:

```sh
curl -sG 'http://localhost:8640/reports/?api=query' --data-urlencode "sql=select count(*) from 'data/daily.csv'"
curl -sG 'http://localhost:8640/reports/weekly.md?api=embed' --data-urlencode 'reference=#totals#0.rain_mm'
```

## Save a result into the markdown

Where a `FOLIO.md`'s `save` section places the document, folio writes a result into a marked region as plain markdown and rewrites it whenever the result changes, so the result also reads on GitHub and in any editor:

````markdown
<!-- folio view: #active -->
<!-- /folio view -->

```sql query active
select s.id, s.owner, s.calibrated from kind.station s where s.status = 'active' order by s.id
```
````

- The reference after `folio view:` is any reference: a data file or a part of one, a `.sql` file, or `#name`.
- folio writes a table, or a single value as text, and never changes a byte outside the region. Never edit inside a region: the next write replaces a hand edit, and health reports it.
- Each marker stands on a line of its own; markers inside a code fence are examples, and folio never writes into them.
- folio writes a view only into a document a `save` entry places; declare one as [references/conventions.md](references/conventions.md) shows.

## Markdown folio renders

- GitHub-flavoured markdown - tables, task lists, strikethrough, footnotes and bare links - plus `$...$` and `$$...$$` math, and fenced code highlighted by the language named after the fence.
- Diagrams: a `mermaid` fence, or a whole `.mmd` or `.mermaid` file as a page. The reader opens any diagram over the whole window to zoom and pan.
- HTML elements: `<details>`, `<kbd>`, `<mark>`, `<sub>`, `<sup>`, `<abbr>`, `<u>`, `<small>`, `<cite>`, `<dfn>`, definition lists, figures and tables with merged cells, each of them taking `class` and `style`. Scripts, event handlers and `javascript:` links are stripped.
- YAML frontmatter shows as a table above the page.
- Loose tables: rows with extra or missing cells, and pipe lines without a divider line, still render as tables.
- Every table but the frontmatter's - written, embedded or queried - sorts, filters, hides columns and folds in the reader's view. Write a table in its natural order.

## Edit so the reader can catch up

folio remembers which blocks the reader has read, and marks each block added (green), changed (amber, the text as read a click away) or removed (a red tick) since; the tree puts a dot after each document holding a mark. A block showing an embed, chart or query result is marked when its data changes, and a block an include brings in when its file changes.

- Change only the blocks whose content changes. Rewrapping a paragraph, repadding a table, line endings and moving a block whole count for nothing; rewording a block, or reordering the items or rows inside it, marks it.
- A moved or reworded block keeps its identity, its links and its history.
- Never write change notes into a document: folio keeps every committed version and the saves it saw - all of them for 30 days, then the last of each day - compares any two block by block, and builds a digest of any period.
- Link every new document from another one. A document unchanged for a year, never read and linked from nowhere surfaces as outlived.
- Before moving, renaming or reshaping a file, ask what uses it - `?api=used-by` on its path lists every document including it, or embedding or querying its data - and update every link, include, embed and figure naming it.

## Check the work

```sh
folio check FOLDER
```

It prints one problem a line - `path:line severity kind what` - and a count. It exits 1 only when a problem is an error: a violation of a rule whose severity is `error`, or a problem of a kind of check a `health` entry declares an error. Contradicted figures, broken links, missing includes, failing queries and diagrams or charts that do not draw are listed but do not fail it unless declared, so read every line naming a file you touched - exit 0 is not a clean folder. It asks the folio serving the folder when one answers, and works the health out itself otherwise.

While folio runs, the same answers come per resource:

| Address | Answers |
|---|---|
| `/?api=health` | Everything wrong in the folder, each problem with its document, line and block |
| `<path>?api=document` | A document's blocks with their ids, its kind and fields, and the data it reads |
| `<path>?api=embed&reference=<ref>` | What a reference written in the document reads |
| `<folder>/?api=query&sql=<select>` | A query's columns, first 5,000 rows and the files it read |
| `<path>?conventions` | The declarations applying to a document, its kind and its fields |
| `<path>?api=provenance&block=<id>` | Where a block came from: its lines, last change, data files and queries, and the state of each figure |
| `<path>?api=used-by` | The documents including a file, or embedding or querying its data |

## Tools for agents

`folio mcp` serves the model as read-only tools, each answering as its `?api=` resource does:

| Tool | Answers |
|---|---|
| `folio_documents` | Every document under a folder, with its kind |
| `folio_document` | A document's blocks with their ids, its kind and fields, and the data it reads |
| `folio_query` | One `SELECT`, run from a folder |
| `folio_embed` | What a reference written in a document reads |
| `folio_kinds` | The declarations applying at a path, and the kinds, rules and health entries they layer to |
| `folio_health` | Everything wrong in the folder |
| `folio_used_by` | The documents including a file, or reading its data |
| `folio_provenance` | Where one block came from |
| `folio_history` | A document's versions; a version's text, each text a block has had, or each result an embed has shown |
| `folio_digest` | Every document created, changed or removed in a period, and every value that moved |
| `folio_needs` | What needs the reader: errors, problems in documents they read, attention rows and changes |
| `folio_presence` | The page in each open tab and the block under the reader's pointer |
| `folio_reads` | What the reader has read, per document or per block |
| `folio_changes` | The documents the reader read that changed since |
| `folio_stale` | Documents that have probably outlived their use |

While the reader has paused sharing, `folio_reads`, `folio_changes`, `folio_needs`, `folio_presence` and `folio_stale` answer only that sharing is paused.
