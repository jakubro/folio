/** `folio lsp`: a language server on standard input and output, for any editor that speaks the protocol. */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  createConnection,
  DiagnosticSeverity,
  type Location,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type TextEdit,
  type WorkspaceEdit,
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"
import type { Data } from "./data.ts"
import {
  definition,
  type Edit,
  type Editor,
  findings,
  headingAt,
  hover,
  moveFiles,
  movesInTurn,
  references,
  renameHeading,
  type Spot,
} from "./editor.ts"
import type { Indexer } from "./indexer.ts"
import type { Model } from "./model.ts"
import { clientName, painter, reading, type Terminal } from "./terminal.ts"

const SETTLE_MS = 200

export async function lsp(
  root: string,
  model: Model,
  data: Data,
  indexer: Indexer,
  output: Terminal,
): Promise<void> {
  const paint = painter(process.stderr)
  let client = "the editor"

  console.error(`${paint("bold", "folio lsp")} serving ${root}`)
  console.error("  on standard input and output")
  // The protocol library ends the process itself, on the exit message or once standard input closes.
  process.once("exit", () => {
    output.progress(undefined)
    output.log(`${client} left`, "info")
  })

  const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout)
  const documents = new TextDocuments(TextDocument)
  const timers = new Map<string, NodeJS.Timeout>()
  const urlPathOf = (uri: string) => {
    if (!uri.startsWith("file:")) {
      return undefined
    }

    const file = fileURLToPath(uri)
    const relative = path.relative(root, file)
    return relative.startsWith("..") || path.isAbsolute(relative)
      ? undefined
      : relative.split(path.sep).join("/")
  }
  const uriOf = (urlPath: string) => pathToFileURL(path.join(root, urlPath)).href
  const editor: Editor = {
    root,
    model,
    data,
    indexer,
    textOf: (urlPath) => {
      const open = documents.get(uriOf(urlPath))

      if (open) {
        return open.getText()
      }

      try {
        return fs.readFileSync(path.join(root, urlPath), "utf8")
      } catch {
        return undefined
      }
    },
  }
  const at = (spot: Spot): Location => ({
    uri: uriOf(spot.path),
    range: {
      start: { line: spot.line, character: spot.start },
      end: { line: spot.line, character: spot.end },
    },
  })
  const workspace = (edits: Edit[]): WorkspaceEdit => {
    const changes: Record<string, TextEdit[]> = {}

    for (const edit of edits) {
      const uri = uriOf(edit.path)
      changes[uri] = [...(changes[uri] ?? []), { range: at(edit).range, newText: edit.text }]
    }

    return { changes }
  }
  const check = (uri: string) => {
    clearTimeout(timers.get(uri))
    timers.set(
      uri,
      setTimeout(async () => {
        const urlPath = urlPathOf(uri)

        if (!urlPath || !model.ready || !documents.get(uri)) {
          return
        }

        const found = await findings(editor, urlPath).catch((error: Error) => {
          connection.console.error(`folio: ${urlPath}: ${error.message}`)
          return []
        })
        await connection.sendDiagnostics({
          uri,
          diagnostics: found.map(({ severity, what, ...spot }) => ({
            range: at({ path: urlPath, ...spot }).range,
            severity: severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
            source: "folio",
            message: what,
          })),
        })
      }, SETTLE_MS),
    )
  }
  const pathAt = (uri: string) => urlPathOf(uri) ?? ""

  connection.onInitialize(({ clientInfo }) => {
    const named = clientName(clientInfo)
    client = named ?? client
    output.log(`${named ?? "an editor"} connected`, "info")
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
        renameProvider: { prepareProvider: true },
        workspace: {
          fileOperations: {
            willRename: {
              filters: [
                {
                  pattern: {
                    glob: "**/*.{md,markdown,mermaid,mmd,png,jpg,jpeg,gif,svg,webp,avif,bmp,ico,csv,tsv,jsonl,ndjson,parquet,json,yaml,yml,sqlite,sqlite3,db,duckdb,sql}",
                  },
                },
                { pattern: { glob: "**", matches: "folder" } },
              ],
            },
          },
        },
      },
      serverInfo: { name: "folio" },
    }
  })
  documents.onDidChangeContent(({ document }) => check(document.uri))
  documents.onDidClose(({ document }) =>
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] }),
  )
  model.listen(() => {
    for (const document of documents.all()) {
      check(document.uri)
    }
  })
  connection.onDefinition(({ textDocument, position }) => {
    if (!urlPathOf(textDocument.uri)) {
      return null
    }

    const found = definition(editor, pathAt(textDocument.uri), position.line, position.character)
    return found ? at(found) : null
  })
  connection.onReferences(async ({ textDocument, position }) =>
    (await references(editor, pathAt(textDocument.uri), position.line)).map(at),
  )
  connection.onHover(async ({ textDocument, position }) => {
    const said = await hover(editor, pathAt(textDocument.uri), position.line)
    return said ? { contents: { kind: "markdown", value: said } } : null
  })
  connection.onPrepareRename(({ textDocument, position }) => {
    const spot = headingAt(editor, pathAt(textDocument.uri), position.line)
    return spot ? at(spot).range : null
  })
  connection.onRenameRequest(async ({ textDocument, position, newName }) => {
    const edits = await renameHeading(editor, pathAt(textDocument.uri), position.line, newName)
    return edits ? workspace(edits) : null
  })
  connection.workspace.onWillRenameFiles(async ({ files }) => {
    const renames = files.flatMap(({ oldUri, newUri }): [string, string][] => {
      const from = urlPathOf(oldUri)
      const to = urlPathOf(newUri)
      return from && to ? [[from, to]] : []
    })

    return workspace(await moveFiles(editor, movesInTurn(root, renames)))
  })

  documents.listen(connection)
  connection.listen()
  const started = Date.now()
  output.progress(() => reading(model))
  await model.start()
  output.progress(undefined)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  output.log(`ready: read ${model.paths().length} documents in ${seconds} s`, "info")

  for (const document of documents.all()) {
    check(document.uri)
  }

  await new Promise<void>((resolve) => connection.onExit(() => resolve()))
}
