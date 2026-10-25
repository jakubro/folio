# Declaring a folder's conventions in FOLIO.md

A file named `FOLIO.md`, in capitals, declares what a folder's documents are and the rules they keep. folio reads it for its folder and everything below it, turns each kind of document into a table any query reads, and checks every rule as the folder changes. Declare a kind for every document shape that recurs - stations, visits, decisions, incidents, tickets - and a rule for every promise those documents should keep.

## The file

`FOLIO.md` is a page like any other: prose saying why each declaration exists, around ` ```yaml folio ` fences holding the declarations. Every `yaml folio` fence of the file is read, in order; a plain `yaml` fence is an example, and a file named `folio.md` is an ordinary page.

````markdown
# Station network conventions

What this folder's documents are, and the rules they keep.

## Stations

A station has a page under `stations/`, named by its id, stating its status, owner and last calibration.

```yaml folio
kinds:
  station:
    where: stations/*.md
    fields:
      id: {from: name}
      status: {from: label}
      owner: {from: label}
      calibrated: {from: label, type: date}
```

## Every active station is owned

```yaml folio
rules:
  owned:
    query: select s.path from kind.station s where s.status = 'active' and s.owner is null
    message: An active station has no owner
```
````

- **Layering** - a declaration applies to its folder and everything below it. A deeper `FOLIO.md` adds to those above: a kind or rule it names again replaces the one above for its own folder, and its health entries follow theirs.
- **Paths** - every path a declaration names is relative to its own folder.
- **Live** - an edit to a declaration applies at once.

Each fence is a YAML map of these sections:

| Section | Shape | Does |
|---|---|---|
| `kinds` | Map of names to `where` and `fields` | Places documents in a kind and reads typed fields from them; each kind is the table `kind.<name>` |
| `rules` | Map of names to `query`, `message` and `severity` | A query that should return no row; each row it returns is a violation listed in health |
| `health` | List of `where` with `skip`, `error` or both | What health leaves out, and which problems fail `folio check` |
| `attention` | Map of names to `query` and `message` | Rows listed under *Needing attention* on folio's front page |
| `stale` | Map holding a `query` | Which documents have outlived their use |
| `save` | List of `where` | The documents folio may write saved views into |
| `digests` | List of `path` and `period` | Digest documents folio writes and keeps current |

**YAML to quote** - a pattern starting with `*` (`'**'`, `'*.md'`), which YAML reads as an alias; a message starting with `{`, which YAML reads as a map; and anything holding ` #`, which starts a comment.

## Kinds

```yaml folio
kinds:
  station:
    where: stations/*.md
    fields:
      id: {from: name}
      status: {from: label}
      owner: {from: label}
      calibrated: {from: label, type: date}
      elevation: {from: frontmatter, key: elevation_m, type: number}
      summary: {from: section}
  visit:
    where: [visits/**/*.md, archive/visits/**/*.md]
    fields:
      day: {from: name, pattern: '^(\d{4}-\d{2}-\d{2})', type: date}
      stations: {from: label, type: list, of: link, to: station, empty: None}
      crew: {from: label, type: list}
```

- **Where** - a path pattern, or a list of them: `**` crosses folders, `*` and `?` stay in one, so `*.md` names only the declaring folder's own files. A bare folder name places nothing and is listed as a problem of the declaration; write `archive/**`.
- **Precedence** - a document is of the first kind placing it, the nearest declaration's kinds first.
- **No field named `path`** - every kind table already has its `path` column.

| Field option | Values |
|---|---|
| `from` | `frontmatter`, `label`, `section`, `folder` or `name` |
| `key` | The frontmatter key, label or heading to read; the field's name by default |
| `type` | `text` (the default), `number`, `date`, `link` or `list` |
| `of` | A list's item type: `text` (the default), `number`, `date` or `link` |
| `to` | For a link, or a list of links: the kind whose documents the ids name |
| `by` | The field of the `to` kind holding the id; `id` by default |
| `empty` | A text, or a list of texts, written for no value, such as `None` |
| `pattern` | For `from: name`: a regular expression whose first group is the value |

- **label** - a line `**Label:** value`, `**Label**: value` or `Label: value` starting any line of a paragraph or a list item, matched ignoring case. Labels stack line under line in one paragraph.
- **section** - the text under the heading named by `key`, matched ignoring case, up to the next heading of its level or above.
- **frontmatter** - a key of the YAML frontmatter. **folder** - the name of the folder holding the document. **name** - the file's name without its extension.
- **text** is the plain text a reader sees, without markup. **date** is an ISO date or time. A **list** is written as list items, or set apart by commas.
- **link** with `to` - a markdown link to a document of that kind, or an id written anywhere in the line, so notes beside the links stay notes. A link to the web is taken as written.
- A value that does not fit its field, or a list item naming nothing, is listed in health under *Values that do not fit their field*, at its line.
- A field is read from the document's own text: a label or section an include brings in belongs to the file holding it.

A document of the `station` kind:

```markdown
---
elevation_m: 412
---

# North ridge

**Status:** active
**Owner:** hydrology
**Calibrated:** 2026-04-02

## Summary

Tipping-bucket gauge and anemometer on the ridge above the reservoir.
```

## Rules

```yaml folio
rules:
  owned:
    query: select s.path from kind.station s where s.status = 'active' and s.owner is null
    message: An active station has no owner
  elevation-matches-survey:
    severity: warning
    message: '{id} says {elevation} m, the survey says {surveyed} m'
    query: |
      select s.path, s.id, s.elevation, v.elevation_m as surveyed
      from kind.station s
      join 'data/survey.csv' v on v.station = s.id
      where s.elevation <> v.elevation_m
```

- **query** - runs from the declaration's folder and reads data files and the folder's documents as any query does. It returns a `path` column, and optionally `line` or `block` to land on; every row whose `path` lies below the declaration's folder is a violation.
- **message** - `{column}` takes each row's value of that column; the rule's name by default.
- **severity** - `error`, the default, or `warning`. Violations are listed in health under *Rule errors* or *Rule warnings*, and an error fails `folio check`.
- A rule whose query fails, or returns no `path`, is listed at the rule's own line with its severity. Violations come and go with every change to what the rule reads.

## Health

```yaml folio
health:
  - where: '**'
    error: [figure, link, include, loop, query, data, field, declaration, view]
  - where: archive/**
    skip: [link]
```

- Each entry names `where` - path patterns - and `skip`, `error` or both: `all`, or kinds of check among `figure`, `link`, `include`, `loop`, `diagram`, `chart`, `query`, `data`, `declaration`, `field`, `rule` and `view`.
- **skip** leaves those problems of the documents it places out of the health view; the documents are still served, indexed and queried.
- **error** makes those problems errors, which fail `folio check`. With no such entry, only violations of rules whose severity is `error` fail it - declare the rest to make `folio check` a gate for every kind of breakage.
- Deeper declarations add entries for their own folders.

## Attention

```yaml folio
attention:
  calibration-due:
    query: select s.path, strftime(s.calibrated, '%Y-%m-%d') as calibrated from kind.station s where s.calibrated < current_date - interval 180 day
    message: Calibration due since {calibrated}
```

Every row the query returns needs the reader: folio's front page lists it under *Needing attention* at the row's `path`, its message filled from the row's columns. A query that cannot run, or returns no `path`, is listed among the errors.

## Stale

```yaml folio
stale:
  query: select s.path from kind.station s where s.status = 'retired'
```

Below the declaration's folder, the documents the query names by `path` are the ones that have outlived their use, in place of the default: a document unchanged for a year, never read and linked to from no other document. The nearest declaration holding a `stale` query decides for each document. A document leaves the list once read or edited in the past year, or linked to.

## Save

```yaml folio
save:
  - where: stations.md
  - where: reports/*.md
```

Names the documents folio may write saved views into: the regions between `<!-- folio view: REF -->` and `<!-- /folio view -->` that each document marks, as [the skill](../SKILL.md) shows. Apart from the digest documents `digests` declares, folio writes nowhere else.

## Digests

```yaml folio
digests:
  - path: digests/{week}.md
    period: week
  - path: today.md
    period: day
```

- **path** - a markdown file relative to the declaration's folder. `{day}` names the day, as `2026-10-15`, and `{week}` the ISO week, as `2026-W42`, so each period gets a document of its own and earlier ones stay as last written; a path naming neither is one document that moves on to each new period.
- **period** - `day` or `week`, by the local calendar.
- folio creates the document with a title and a region marked `<!-- folio view: digest -->`, and keeps the region current: each document created, changed or removed in the period, grouped by folder and linked, and each embedded value that moved, as before -> after.
- A path under a dot-folder or `node_modules`, or leading out of the served folder, is listed as a problem. With no `digests` entry, no digest is written.

## Check a declaration

- A fence that is not YAML, is not a map, names a section other than the seven or gives one the wrong shape is listed in health under *Declarations that cannot be read*, at its line, and left out; the file's other fences still apply.
- `?conventions` on a path, or the `folio_kinds` tool, shows the declarations applying there in the order they layer, and the document's kind and the value of each field:

```sh
curl -s 'http://localhost:8640/stations/north.md?conventions'
```

- Query a kind before writing a rule over it, and run `folio check` after: every misfit field and every violation is listed.

```sh
curl -sG 'http://localhost:8640/?api=query' --data-urlencode 'sql=select * from kind.station'
```
