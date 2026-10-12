# folio

A markdown server for one folder. folio shows every markdown file, mermaid diagram and image in a folder in your browser, and updates an open page the moment you save it.

![folio showing a page with a formula, highlighted code and a flowchart, between the folder's file tree and the page's outline](images/folio.png)

## Install and run

folio needs Node.js 22.18 or later.

```sh
npm install --global @jakubro/folio
folio ~/notes
```

Open `http://localhost:8640/`. Without a folder, folio serves the current directory; `--port` picks another port. Stop it with <kbd>Ctrl</kbd>+<kbd>C</kbd>.

The [guide](guide.md) covers what folio adds to markdown and to reading; the [reference](reference.md) lists every option, key and rule.
