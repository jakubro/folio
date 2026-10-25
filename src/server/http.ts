/** HTTP surface: the served folder's own paths, plus query-string views of them that no folder path can shadow. */

import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { unmarked } from "../client/unresolved.ts";
import { api, PAUSED, Refusal } from "./api.ts";
import { conventionsOf } from "./conventions.ts";
import type { Data } from "./data.ts";
import { digest } from "./digest.ts";
import { isDocument, isInside, isPruned, neighbours, renderable } from "./files.ts";
import { healthOf } from "./health.ts";
import { impactOf } from "./impact.ts";
import type { Model } from "./model.ts";
import { needsOf } from "./needs.ts";
import { presenceOf } from "./presence.ts";
import { provenance } from "./provenance.ts";
import { shell } from "./shell.ts";
import { staleOf } from "./stale.ts";
import {
  changesState,
  fileVersion,
  folderState,
  linksState,
  pageState,
  readState,
} from "./versions.ts";

export type Log = (line: string) => void;

const WEEK_MS = 7 * 86_400_000;
/** The views made of the read record - a page's own state carries it too. */
const READER_VIEWS = ["read", "changed", "needs-data", "stale-data", "page"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
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
};
const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const PAGE_POLICY = [
  "default-src 'self'",
  "img-src * data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

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
    response.once("close", () => log(`${request.method} ${request.url} ${response.statusCode}`));

    if (!isLocal(request.headers.host)) {
      return send(response, 403, "Forbidden: folio answers localhost only.\n");
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    let urlPath: string;

    try {
      urlPath = decodeURIComponent(url.pathname).slice(1);
    } catch {
      return send(response, 400, "Bad request.\n");
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return send(response, 405, "Method not allowed.\n");
    }

    // Another site's page can make a browser send this, and a query costs: refused before any work runs.
    if (url.searchParams.has("api")) {
      return foreign(request)
        ? send(response, 403, "Forbidden: the API answers localhost only.\n")
        : answer(response, api(root, model, data, urlPath, url.searchParams));
    }

    // A page's script cannot set the header, so while sharing is paused only folio's own pages are told.
    if (
      presenceOf(model).paused &&
      request.headers["sec-fetch-site"] !== "same-origin" &&
      READER_VIEWS.some((view) => url.searchParams.has(view))
    ) {
      return sendJson(response, PAUSED);
    }

    const asset = url.searchParams.get("asset");

    if (asset !== null) {
      return serveAsset(request, response, assetsDir, asset.replace(/^\//, ""));
    }

    if (url.searchParams.has("digest-data")) {
      const to = Number(url.searchParams.get("to") ?? Date.now());
      const since = url.searchParams.has("since-last");
      const asked = Number(url.searchParams.get("from"));

      return Number.isFinite(to) && (since || Number.isFinite(asked))
        ? answer(
            response,
            model.history
              .lastDigest()
              .then((last) => digest(root, model, since ? (last ?? to - WEEK_MS) : asked, to)),
          )
        : send(response, 400, "A digest needs a from and a to, in milliseconds.\n");
    }

    if (url.searchParams.has("health-data")) {
      const since = url.searchParams.get("since");
      const health = healthOf(model, data);
      return answer(response, since ? health.since(since) : health.state());
    }

    if (url.searchParams.has("stale-data")) {
      return answer(response, staleOf(model, data));
    }

    if (url.searchParams.has("needs-data")) {
      return answer(response, needsOf(model, data));
    }

    if (url.searchParams.has("changed")) {
      return answer(response, changesState(root, model, data));
    }

    if (url.searchParams.has("tree")) {
      const state = folderState(root, urlPath, url.searchParams.has("data"));
      return state ? sendJson(response, state) : notFound(response);
    }

    if (url.searchParams.has("step")) {
      const around = neighbours(root, urlPath);
      return around ? sendJson(response, around) : notFound(response);
    }

    const target = renderable(root, urlPath);
    const textual = target && isDocument(target.kind) ? target : undefined;

    if (url.searchParams.has("data")) {
      if (target?.kind !== "data") {
        return notFound(response);
      }

      const table = url.searchParams.get("table") ?? undefined;
      return answer(response, data.page(target.file, fileVersion(target.file) ?? "", table));
    }

    const past = textual ? urlPath : pastDocument(root, urlPath);

    // A history page names what it shows in its own query, which no other view may answer.
    if (url.searchParams.has("history")) {
      return past ? sendShell(response, urlPath, root, build) : notFound(response);
    }

    const embed = url.searchParams.get("embed");

    if (embed !== null) {
      return textual
        ? answer(
            response,
            data.embedReference(textual.file, embed).then((embedded) => {
              void model.history.value(urlPath, embed, embedded);
              return embedded;
            }),
          )
        : notFound(response);
    }

    const history = model.history;

    if (url.searchParams.has("versions")) {
      return past
        ? answer(
            response,
            Promise.all([history.versions(past), history.references(past)]).then(
              ([versions, values]) => ({ path: past, versions, values }),
            ),
          )
        : notFound(response);
    }

    const shown = url.searchParams.get("version");

    if (shown !== null) {
      return past
        ? answer(
            response,
            history.text(past, shown).then((text) => (text === undefined ? {} : { text })),
          )
        : notFound(response);
    }

    const compared = url.searchParams.get("compare")?.split(",");

    if (compared) {
      return past && compared.length === 2
        ? answer(
            response,
            history.compare(past, compared[0], compared[1]).then((pairs) => ({ pairs })),
          )
        : notFound(response);
    }

    const block = url.searchParams.get("block-history");

    if (block !== null) {
      return past
        ? answer(
            response,
            history.block(past, block, model.held(past) ?? []).then((versions) => ({ versions })),
          )
        : notFound(response);
    }

    const reference = url.searchParams.get("value-history");

    if (reference !== null) {
      return past
        ? answer(
            response,
            history.values(past, reference).then((results) => ({ reference, results })),
          )
        : notFound(response);
    }

    const traced = url.searchParams.get("provenance");

    if (traced !== null) {
      const source = url.searchParams.get("source") ?? urlPath;
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
        : notFound(response);
    }

    if (url.searchParams.has("conventions")) {
      return textual
        ? sendJson(response, conventionsOf(model).describe(urlPath))
        : notFound(response);
    }

    if (url.searchParams.has("model")) {
      const view = textual ? model.inspect(urlPath) : undefined;

      if (textual) {
        if (!view) {
          return notFound(response);
        }

        const page = pageState(root, textual.file, model).blocks;
        return answer(
          response,
          data.dependencies(textual.file).then((files) => ({ ...view, page, data: files })),
        );
      }

      const status = (urlPath === "" || urlPath.endsWith("/")) && folderState(root, urlPath);
      return status ? sendJson(response, model.status(urlPath)) : notFound(response);
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
        : notFound(response);
    }

    if (url.searchParams.has("links")) {
      return textual
        ? sendJson(
            response,
            linksState(model, urlPath, pageState(root, textual.file, model).blocks),
          )
        : notFound(response);
    }

    if (url.searchParams.has("read")) {
      return textual
        ? answer(
            response,
            readState(model, urlPath, pageState(root, textual.file, model).blocks, data),
          )
        : notFound(response);
    }

    if (url.searchParams.has("page")) {
      if (!textual) {
        return notFound(response);
      }

      const { text, version, blocks, layout } = pageState(root, textual.file, model);
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
      );
    }

    if (url.searchParams.has("raw")) {
      if (!textual) {
        return notFound(response);
      }

      const { text, version } = pageState(root, textual.file, model);
      response.setHeader("X-Folio-Version", version);
      return send(response, 200, unmarked(text), "text/plain; charset=utf-8");
    }

    if (target?.kind === "image") {
      return serveFile(
        request,
        response,
        target.file,
        IMAGE_TYPES[path.extname(target.file).toLowerCase()],
      );
    }

    if (target || ((urlPath === "" || urlPath.endsWith("/")) && folderState(root, urlPath))) {
      return sendShell(response, urlPath, root, build);
    }

    if (!urlPath.endsWith("/") && folderState(root, urlPath)) {
      response.setHeader("Location", `${url.pathname}/`);
      return send(response, 301, "");
    }

    notFound(response);
  };

  return (request, response) => {
    try {
      route(request, response);
    } catch (error) {
      log(`${request.method} ${request.url}: ${(error as Error).message}`);

      if (!response.headersSent) {
        send(response, 500, "folio could not answer this request.\n");
      }
    }
  };
}

export function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use.`) : error);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

/** Tell whether a Host or Origin header names this machine. */
export function isLocal(header: string | undefined): boolean {
  const host = (header ?? "").replace(/^https?:\/\//, "").replace(/:\d+$/, "");
  return LOCAL_HOSTS.has(host);
}

/**
 * A document no longer in the folder still has a history, under the address it had, as long as
 * the folders that remain of its path lead nowhere outside the served folder.
 */
function pastDocument(root: string, urlPath: string): string | undefined {
  const parts = urlPath.split("/");

  if (
    !/\.(md|markdown|mermaid|mmd)$/i.test(urlPath) ||
    parts.some((part) => part === ".." || part === "." || part === "" || isPruned(part))
  ) {
    return undefined;
  }

  // A path that is there - a symlink leading outside, say - is no past document.
  try {
    fs.lstatSync(path.join(root, urlPath));
    return undefined;
  } catch {
    // Gone: its history may be asked for.
  }

  for (let dir = path.dirname(path.join(root, urlPath)); ; dir = path.dirname(dir)) {
    if (fs.existsSync(dir)) {
      return isInside(root, fs.realpathSync(dir)) ? urlPath : undefined;
    }
  }
}

function sendShell(
  response: http.ServerResponse,
  urlPath: string,
  root: string,
  build: string,
): void {
  response.setHeader("Content-Security-Policy", PAGE_POLICY);
  send(
    response,
    200,
    shell(path.posix.basename(urlPath) || path.basename(root), path.basename(root), build),
    "text/html; charset=utf-8",
  );
}

function send(
  response: http.ServerResponse,
  status: number,
  body: string,
  type = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(body);
}

function sendJson(response: http.ServerResponse, value: unknown): void {
  send(response, 200, JSON.stringify(value), "application/json");
}

/** Whatever an answer's work throws, or its value fails to become JSON, the request ends with a 500. */
function answer(response: http.ServerResponse, work: Promise<unknown>): void {
  work
    .then((value) => sendJson(response, value))
    .catch((error: Error) => {
      if (response.headersSent) {
        response.destroy();
      } else {
        send(response, error instanceof Refusal ? error.status : 500, `${error.message}\n`);
      }
    });
}

function foreign(request: http.IncomingMessage): boolean {
  const site = request.headers["sec-fetch-site"];
  const origin = request.headers.origin;

  return (
    (origin !== undefined && !isLocal(origin)) || site === "cross-site" || site === "same-site"
  );
}

function notFound(response: http.ServerResponse): void {
  send(response, 404, "Not found.\n");
}

function serveAsset(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  assetsDir: string,
  name: string,
): void {
  const type = ASSET_TYPES[path.extname(name)];

  if (!type || !/^[\w-]+\.\w+$/.test(name)) {
    notFound(response);
    return;
  }

  serveFile(request, response, path.join(assetsDir, name), type);
}

/** Revalidated on every load, so an edited image or an upgraded package shows on the next reload. */
function serveFile(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  file: string,
  type: string,
): void {
  const version = fileVersion(file);

  if (!version) {
    notFound(response);
    return;
  }

  const etag = `"${version}"`;
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": type,
    "Cache-Control": "no-cache",
    ETag: etag,
  };

  // An SVG opened directly is a document that could run script; sandboxing keeps it an image.
  if (type === IMAGE_TYPES[".svg"]) {
    headers["Content-Security-Policy"] = "sandbox";
  }

  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }

  response.writeHead(200, headers);

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  fs.createReadStream(file).pipe(response);
}
