/** HTTP surface: the served folder's own paths, plus query-string views of them that no folder path can shadow. */

import fs from "node:fs"
import type http from "node:http"
import path from "node:path"
import { unmarked } from "../client/unresolved.ts"
import { api, PAUSED, Refusal } from "./api.ts"
import { ask } from "./check.ts"
import { conventionsOf } from "./conventions.ts"
import type { Compared, Data, Filter, Order, Search } from "./data.ts"
import { digest } from "./digest.ts"
import { isDocument, isInside, isPruned, neighbours, renderable } from "./files.ts"
import { healthOf } from "./health.ts"
import { impactOf } from "./impact.ts"
import type { Model } from "./model.ts"
import { needsOf } from "./needs.ts"
import { presenceOf } from "./presence.ts"
import { provenance } from "./provenance.ts"
import { shell } from "./shell.ts"
import { staleOf } from "./stale.ts"
import {
  changesState,
  fileVersion,
  folderState,
  linksState,
  pageState,
  readState,
} from "./versions.ts"

export type Level = "request" | "update" | "opened" | "info" | "warning" | "error"
/** A line for whoever watches folio, an error unless it says otherwise. */
export type Log = (line: string, level?: Level) => void

const WEEK_MS = 7 * 86_400_000
/** The views made of the read record - a page's own state carries it too. */
const READER_VIEWS = ["read", "changed", "needs-data", "stale-data", "page"]
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])
const LOOKUPS = /^\?(?:page|tree|data)(?:[&=]|$)/
const FAILURES = new WeakMap<http.ServerResponse, string>()
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
}
const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
}
const PAGE_POLICY = [
  "default-src 'self'",
  "img-src * data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ")

/** Build the request handler for a real root folder. */
export function createHandler(
  root: string,
  assetsDir: string,
  build: string,
  model: Model,
  data: Data,
  log: Log,
): http.RequestListener {
  const route: http.RequestListener = (request, response) => {
    // The page's own lookups, a browser's /favicon.ico and /.well-known/ ask whether something is there.
    const asked = () =>
      response.statusCode === 404 &&
      ((request.method === "HEAD" &&
        IMAGE_TYPES[path.extname(request.url?.split("?")[0] ?? "").toLowerCase()] !== undefined) ||
        request.url === "/favicon.ico" ||
        request.url?.startsWith("/.well-known/") ||
        LOOKUPS.test(request.url?.slice(request.url.indexOf("?")) ?? ""))

    response.once("close", () => {
      const failure = FAILURES.get(response)

      log(
        `${request.method} ${request.url} ${response.statusCode}${failure ? `: ${failure}` : ""}`,
        failure || response.statusCode >= 500
          ? "error"
          : response.statusCode >= 400 && !asked()
            ? "warning"
            : "request",
      )
    })

    if (!isLocal(request.headers.host)) {
      return send(response, 403, "Forbidden: folio answers localhost only.\n")
    }

    const url = new URL(request.url ?? "/", "http://localhost")
    let urlPath: string

    try {
      urlPath = decodeURIComponent(url.pathname).slice(1)
    } catch {
      return send(response, 400, "Bad request.\n")
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return send(response, 405, "Method not allowed.\n")
    }

    // Another site's page can make a browser send this, and a query costs: refused before any work runs.
    if (url.searchParams.has("api")) {
      return foreign(request)
        ? send(response, 403, "Forbidden: the API answers localhost only.\n")
        : answer(response, api(root, model, data, urlPath, url.searchParams))
    }

    // A page's script cannot set the header, so while sharing is paused only folio's own pages are told.
    if (
      presenceOf(model).paused &&
      request.headers["sec-fetch-site"] !== "same-origin" &&
      READER_VIEWS.some((view) => url.searchParams.has(view))
    ) {
      return sendJson(response, PAUSED)
    }

    const asset = url.searchParams.get("asset")

    if (asset !== null) {
      return serveAsset(request, response, assetsDir, asset.replace(/^\//, ""))
    }

    if (url.searchParams.has("digest-data")) {
      const to = Number(url.searchParams.get("to") ?? Date.now())
      const since = url.searchParams.has("since-last")
      const asked = Number(url.searchParams.get("from"))

      return Number.isFinite(to) && (since || Number.isFinite(asked))
        ? answer(
            response,
            model.history
              .lastDigest()
              .then((last) => digest(root, model, since ? (last ?? to - WEEK_MS) : asked, to)),
          )
        : send(response, 400, "A digest needs a from and a to, in milliseconds.\n")
    }

    if (url.searchParams.has("health-data")) {
      const since = url.searchParams.get("since")
      const health = healthOf(model, data)
      return answer(response, since ? health.since(since) : health.state())
    }

    if (url.searchParams.has("stale-data")) {
      return answer(response, staleOf(model, data))
    }

    if (url.searchParams.has("needs-data")) {
      return answer(response, needsOf(model, data))
    }

    if (url.searchParams.has("changed")) {
      return answer(response, changesState(root, model, data))
    }

    if (url.searchParams.has("tree")) {
      const state = folderState(root, urlPath, url.searchParams.has("data"))
      return state ? sendJson(response, state) : notFound(response)
    }

    if (url.searchParams.has("step")) {
      const around = neighbours(root, urlPath)
      return around ? sendJson(response, around) : notFound(response)
    }

    if (url.searchParams.has("not-found")) {
      const past = pastDocument(root, urlPath)
      const name = path.posix.basename(urlPath)

      return answer(
        response,
        (past ? model.history.versions(past) : Promise.resolve([])).then(async (versions) => {
          const saved = versions.some(({ seen }) => seen.includes("saved"))
          const moved = past && !saved ? await model.history.movedTo(past) : undefined

          return {
            history: versions.length > 0 || moved !== undefined,
            ...(moved !== undefined && { moved }),
            named: model
              .paths()
              .filter((other) => other !== urlPath && path.posix.basename(other) === name)
              .sort(),
            ready: model.ready,
          }
        }),
      )
    }

    const target = renderable(root, urlPath)
    const textual = target && isDocument(target.kind) ? target : undefined

    if (url.searchParams.has("data")) {
      if (target?.kind !== "data") {
        return notFound(response)
      }

      const table = url.searchParams.get("table") ?? undefined
      const version = fileVersion(target.file) ?? ""
      const order = parsed<Order>(
        url.searchParams.get("sort"),
        (value) => Number.isInteger(value.column) && typeof value.descending === "boolean",
      )
      const filtering = (value: Record<string, unknown>) =>
        typeof value.field === "string" &&
        (typeof value.eq === "string" ||
          (typeof value.from === "number" && typeof value.to === "number"))
      const filter = parsed<Filter>(url.searchParams.get("filter"), filtering)
      const compared = parsed<Compared>(
        url.searchParams.get("compare"),
        (value) =>
          (value.by === undefined || typeof value.by === "string") &&
          (value.filter === undefined ||
            (value.filter !== null &&
              typeof value.filter === "object" &&
              filtering(value.filter as Record<string, unknown>))) &&
          (value.by !== undefined || value.filter !== undefined),
      )

      const search = parsed<Search>(
        url.searchParams.get("search"),
        (value) =>
          typeof value.text === "string" &&
          Array.isArray(value.columns) &&
          value.columns.every(
            (pair) =>
              Array.isArray(pair) && Number.isInteger(pair[0]) && typeof pair[1] === "string",
          ) &&
          Array.isArray(value.hidden) &&
          value.hidden.every(Number.isInteger),
      )

      if (order === null || filter === null || search === null || compared === null) {
        return send(
          response,
          400,
          "A sort names a column by its place and a direction, a filter a field and a value or a range, a search its text and columns by place, a comparison a filter or a field.\n",
        )
      }

      if (compared) {
        return answer(response, data.compare(target.file, version, table, compared))
      }

      if (url.searchParams.has("stats")) {
        return answer(response, data.stats(target.file, version, table, filter))
      }

      return answer(
        response,
        data.page(target.file, version, table, {
          order,
          filter,
          search,
          rows: Number(url.searchParams.get("rows") ?? Number.NaN),
          offset: Number(url.searchParams.get("offset") ?? Number.NaN),
        }),
      )
    }

    const past = textual ? urlPath : pastDocument(root, urlPath)

    // A history page names what it shows in its own query, which no other view may answer.
    if (url.searchParams.has("history")) {
      return past ? sendShell(response, urlPath, root, build) : notFound(response)
    }

    const embed = url.searchParams.get("embed")

    if (embed !== null) {
      return textual
        ? answer(
            response,
            data.embedReference(textual.file, embed).then((embedded) => {
              void model.history.value(urlPath, embed, embedded)
              return embedded
            }),
          )
        : notFound(response)
    }

    const history = model.history

    if (url.searchParams.has("versions")) {
      return past
        ? answer(
            response,
            Promise.all([history.versions(past), history.references(past)]).then(
              ([versions, values]) => ({ path: past, versions, values }),
            ),
          )
        : notFound(response)
    }

    const shown = url.searchParams.get("version")

    if (shown !== null) {
      return past
        ? answer(
            response,
            history.text(past, shown).then((text) => (text === undefined ? {} : { text })),
          )
        : notFound(response)
    }

    const compared = url.searchParams.get("compare")?.split(",")

    if (compared) {
      return past && compared.length === 2
        ? answer(
            response,
            history.compare(past, compared[0], compared[1]).then((pairs) => ({ pairs })),
          )
        : notFound(response)
    }

    const block = url.searchParams.get("block-history")

    if (block !== null) {
      return past
        ? answer(
            response,
            history.block(past, block, model.held(past) ?? []).then((versions) => ({ versions })),
          )
        : notFound(response)
    }

    const reference = url.searchParams.get("value-history")

    if (reference !== null) {
      return past
        ? answer(
            response,
            history.values(past, reference).then((results) => ({ reference, results })),
          )
        : notFound(response)
    }

    const traced = url.searchParams.get("provenance")

    if (traced !== null) {
      const source = url.searchParams.get("source") ?? urlPath
      return textual
        ? answer(
            response,
            provenance(
              root,
              model,
              data,
              pageState(root, textual.file, model),
              urlPath,
              source,
              traced,
              Number(url.searchParams.get("at") ?? 0) || 0,
            ).then((found) => found ?? {}),
          )
        : notFound(response)
    }

    if (url.searchParams.has("conventions")) {
      return textual
        ? sendJson(response, conventionsOf(model).describe(urlPath))
        : notFound(response)
    }

    if (url.searchParams.has("model")) {
      const view = textual ? model.inspect(urlPath) : undefined

      if (textual) {
        if (!view) {
          return notFound(response)
        }

        const page = pageState(root, textual.file, model).blocks
        return answer(
          response,
          data.dependencies(textual.file).then((files) => ({ ...view, page, data: files })),
        )
      }

      const status = (urlPath === "" || urlPath.endsWith("/")) && folderState(root, urlPath)
      return status ? sendJson(response, model.status(urlPath)) : notFound(response)
    }

    if (url.searchParams.has("used-by")) {
      return target
        ? model.ready
          ? answer(
              response,
              impactOf(model, data)
                .dependents(urlPath)
                .then((documents) => ({ ready: true, documents })),
            )
          : sendJson(response, { ready: false, documents: [] })
        : notFound(response)
    }

    if (url.searchParams.has("links")) {
      return textual
        ? sendJson(
            response,
            linksState(model, urlPath, pageState(root, textual.file, model).blocks),
          )
        : notFound(response)
    }

    if (url.searchParams.has("read")) {
      return textual
        ? answer(
            response,
            readState(model, urlPath, pageState(root, textual.file, model).blocks, data),
          )
        : notFound(response)
    }

    if (url.searchParams.has("page")) {
      if (!textual) {
        return notFound(response)
      }

      const { text, version, blocks, layout } = pageState(root, textual.file, model)
      return answer(
        response,
        readState(model, urlPath, blocks, data).then((read) => ({
          text,
          version,
          blocks,
          layout,
          links: linksState(model, urlPath, blocks),
          read,
        })),
      )
    }

    if (url.searchParams.has("raw")) {
      if (!textual) {
        return notFound(response)
      }

      const { text, version } = pageState(root, textual.file, model)
      response.setHeader("X-Folio-Version", version)
      return send(response, 200, unmarked(text), "text/plain; charset=utf-8")
    }

    if (target?.kind === "image") {
      return serveFile(
        request,
        response,
        target.file,
        IMAGE_TYPES[path.extname(target.file).toLowerCase()],
      )
    }

    if (target || ((urlPath === "" || urlPath.endsWith("/")) && folderState(root, urlPath))) {
      return sendShell(response, urlPath, root, build)
    }

    if (!urlPath.endsWith("/") && folderState(root, urlPath)) {
      response.setHeader("Location", `${url.pathname}/`)
      return send(response, 301, "")
    }

    // Scripts read a query's 404 as plain text; only an address a browser opens gets the window.
    if (url.search) {
      return notFound(response)
    }

    sendShell(response, urlPath, root, build, 404)
  }

  return (request, response) => {
    try {
      route(request, response)
    } catch (error) {
      FAILURES.set(response, (error as Error).message)

      if (response.headersSent) {
        response.destroy()
      } else {
        send(response, 500, "folio could not answer this request.\n")
      }
    }
  }
}

export function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const listening = () => resolve((server.address() as { port: number }).port)

    server.once("error", (error: NodeJS.ErrnoException) => {
      server.off("listening", listening)
      reject(
        error.code === "EADDRINUSE"
          ? Object.assign(new Error(`Port ${port} is already in use.`), { code: error.code })
          : error,
      )
    })
    server.once("listening", listening)
    server.listen(port, "127.0.0.1")
  })
}

/** Listen on the first free port from `port` up, unless a folio already serves `root` on one taken. */
export async function listenFree(server: http.Server, port: number, root: string): Promise<number> {
  for (let next = port; next <= 65535; next++) {
    try {
      return await listen(server, next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error
      }
    }

    const index = (await ask({ port: next }, "/?api").catch(() => undefined)) as {
      root?: unknown
    }

    if (index?.root === root) {
      throw new Error(`${root} is already served at http://localhost:${next}/`)
    }
  }

  throw new Error(`No port is free from ${port} up.`)
}

/** Tell whether a Host or Origin header names this machine. */
export function isLocal(header: string | undefined): boolean {
  const host = (header ?? "").replace(/^https?:\/\//, "").replace(/:\d+$/, "")
  return LOCAL_HOSTS.has(host)
}

/**
 * A document no longer in the folder still has a history, under the address it had, as long as
 * the folders that remain of its path lead nowhere outside the served folder.
 */
function pastDocument(root: string, urlPath: string): string | undefined {
  const parts = urlPath.split("/")

  if (
    !/\.(md|markdown|mermaid|mmd)$/i.test(urlPath) ||
    parts.some((part) => part === ".." || part === "." || part === "" || isPruned(part))
  ) {
    return undefined
  }

  // A path that is there - a symlink leading outside, say - is no past document.
  try {
    fs.lstatSync(path.join(root, urlPath))
    return undefined
  } catch {
    // Gone: its history may be asked for.
  }

  for (let dir = path.dirname(path.join(root, urlPath)); ; dir = path.dirname(dir)) {
    if (fs.existsSync(dir)) {
      return isInside(root, fs.realpathSync(dir)) ? urlPath : undefined
    }
  }
}

function sendShell(
  response: http.ServerResponse,
  urlPath: string,
  root: string,
  build: string,
  status = 200,
): void {
  response.setHeader("Content-Security-Policy", PAGE_POLICY)
  send(
    response,
    status,
    shell(
      path.posix.basename(urlPath) || path.basename(root),
      path.basename(root),
      build,
      status === 404,
    ),
    "text/html; charset=utf-8",
  )
}

/** A JSON parameter of the shape given; undefined when absent, null when it is not JSON or not that shape. */
function parsed<T>(
  text: string | null,
  shaped: (value: Record<string, unknown>) => boolean,
): T | undefined | null {
  if (text === null) {
    return undefined
  }

  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === "object" && shaped(value) ? (value as T) : null
  } catch {
    return null
  }
}

function send(
  response: http.ServerResponse,
  status: number,
  body: string,
  type = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" })
  response.end(body)
}

function sendJson(response: http.ServerResponse, value: unknown): void {
  send(response, 200, JSON.stringify(value), "application/json")
}

/** Whatever an answer's work throws, or its value fails to become JSON, the request ends with a 500. */
function answer(response: http.ServerResponse, work: Promise<unknown>): void {
  work
    .then((value) => sendJson(response, value))
    .catch((error: Error) => {
      if (!(error instanceof Refusal)) {
        FAILURES.set(response, error.message)
      }

      if (response.headersSent) {
        response.destroy()
      } else {
        send(response, error instanceof Refusal ? error.status : 500, `${error.message}\n`)
      }
    })
}

function foreign(request: http.IncomingMessage): boolean {
  const site = request.headers["sec-fetch-site"]
  const origin = request.headers.origin

  return (origin !== undefined && !isLocal(origin)) || site === "cross-site" || site === "same-site"
}

function notFound(response: http.ServerResponse): void {
  send(response, 404, "Not found.\n")
}

function serveAsset(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  assetsDir: string,
  name: string,
): void {
  const type = ASSET_TYPES[path.extname(name)]

  if (!type || !/^[\w-]+\.\w+$/.test(name)) {
    notFound(response)
    return
  }

  serveFile(request, response, path.join(assetsDir, name), type)
}

/** Revalidated on every load, so an edited image or an upgraded package shows on the next reload. */
function serveFile(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  file: string,
  type: string,
): void {
  const version = fileVersion(file)

  if (!version) {
    notFound(response)
    return
  }

  const etag = `"${version}"`
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": type,
    "Cache-Control": "no-cache",
    ETag: etag,
  }

  // An SVG opened directly is a document that could run script; sandboxing keeps it an image.
  if (type === IMAGE_TYPES[".svg"]) {
    headers["Content-Security-Policy"] = "sandbox"
  }

  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers)
    response.end()
    return
  }

  response.writeHead(200, headers)

  if (request.method === "HEAD") {
    response.end()
    return
  }

  fs.createReadStream(file).pipe(response)
}
