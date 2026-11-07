# Addresses

Every file's address is its path in the folder, so links between files work as they do on disk.

| Address | Shows |
|---|---|
| `/<path>` to a markdown or mermaid file | The rendered page |
| `/<path>` to an image | The image |
| `/<path>` to a data or `.sql` file | Its page: rows, tree or tables; for a query, its text and result |
| `/` | What needs you: every error, the problems in documents you have read, the rows of the folder's attention queries, and the documents you read that changed since, in that order, following every change live |
| `/?files` | The served folder's own listing |
| `/favicon.ico` | Folio's icon, a navy F on a light blue square, unless the folder holds a `favicon.ico` of its own |
| `/<folder>/` | The folder's listing; the address without its closing slash redirects to it |
| Any other address | Folio's not-found page, with a 404: the address, a link to the history of a document that lived there - wherever it moved since - and the documents of the folder with the same file name. Saving a document at the address turns the page into it. An address with a query that names nothing answers a plain-text 404 |
| `/<path>?raw` | The file's text with its includes expanded |
| `/<path>?table=<name>` to a database | One table of the database, 200 rows at a time |
| `/<path>?filter=<filter>` to a data file | Its page showing only the records a field's value or range keeps, as picked in its statistics |
| `/<path>?view=<views>` | The page with its tables' views - sort, filters, hidden columns, rows shown - as they were when the address was copied |
| `/<path>?conventions` | What the folder declares of the document, as JSON: the declarations applying to it, in the order they layer, and its kind and fields |
| `/<path>?model` | The file's blocks in Folio's model of the folder, as JSON: each block's id, kind, lines and the start of its text |
| `/<folder>/?model` | Whether the model is complete, and how many documents it holds under the folder |
| `/?stale` | Documents that have probably outlived their use, oldest change first, each with why, following every change live; Folio only lists them |
| `/?stale-data` | The same as JSON |
| `/?needs-data` | What needs you as JSON: each item's source - `error`, `problem`, `attention` or `changed` - document, line and what is wrong, and whether every part is known; before Folio has read the folder, each part answers as it was last shown |
| `/?catch-up` | The catch-up list: every document read before whose blocks changed since, newest change first |
| `/?changed` | The catch-up list as JSON |
| `/?health` | Everything wrong in the folder, grouped by kind and by folder |
| `/?health-data` | The same as JSON: each problem's kind, document, line, block and what is wrong, and whether health is known; before Folio has read the folder, as it was last worked out |
| `/<path>?history` | The document's versions, newest first, with a choice of two to compare |
| `/<path>?history&at=<version>` | One version of the document, read only |
| `/<path>?history&compare=<older>,<newer>` | Two versions block by block, side by side |
| `/<path>?history&block=<id>` | Each text one block has had, newest first |
| `/<path>?history&embed=<reference>` | Each result an embed of the document has shown, newest first |
| `/<path>?versions` | The document's versions as JSON, and the embeds whose results are kept |
| `/<path>?used-by` | The documents that include the file, or embed or query its data, as JSON, and whether Folio has finished reading the folder |
| `/?digest` | A digest of today; `&period=week` of this week since Monday, `&period=since-last` since the last digest was built, `&from=<date>&to=<date>` of those days |
| `/?digest-data&from=<ms>&to=<ms>` | A digest as JSON; `&since-last` in place of `from` |
| `/<path>?provenance=<id>&source=<file>` | Where a block of the page came from, as JSON: its file, lines and when it last changed, the section an include brought it from, the data files and queries it is computed from, and the state of each figure it ties to data |
| `/<path>?read` | Each block of the page with the version shown and, once read, the version read and when, and what is marked new, changed or removed, as JSON |

What needs you also holds the switch that pauses sharing with agents: while paused, the API tells them sharing is paused rather than what you read, what is new to you, what needs you or what you look at, and `?read`, `?changed`, `?needs-data`, `?stale-data` and `?page` answer the same to anything but Folio's own pages in a browser. Folio tells its pages by the `Sec-Fetch-Site: same-origin` header a browser adds to their requests, so a program on this machine that sends the header itself is answered as a page: the pause holds back the API, MCP and any tool asking through them, not a program passing itself off as a page. The switch is Folio's, kept across restarts and shared by every browser.
