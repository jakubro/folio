# folio

A live view of a folder of markdown and data, in your browser. folio renders every page with GitHub-flavoured markdown, math, highlighted code and diagrams, keeps each one current as you save, and knows the folder as a whole: what links where, what changed since you last read it, which figures no longer match their data, and what is broken.

![folio showing a page with a formula, highlighted code and a flowchart, between the folder's file tree and the page's outline](images/folio.png)

## Try it

folio needs Node.js 22.18 or later.

```sh
npx @jakubro/folio ~/notes
```

Open `http://localhost:8640/`. Without a folder, folio serves the current directory; `--port` picks another port, and <kbd>Ctrl</kbd>+<kbd>C</kbd> stops it. To keep it installed:

```sh
npm install --global @jakubro/folio
folio ~/notes
```

folio reads your folder and writes into it only what a `FOLIO.md` there asks for. What it remembers - its model of the folder, what you have read, the versions it saw - lives in `~/.local/state/folio/`.

## Next

- The [guide](guide.md) shows what folio adds, from live pages and data in documents to catching up on what changed.
- The [reference](reference.md) lists every option, address, key and rule.
