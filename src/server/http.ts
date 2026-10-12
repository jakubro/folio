// HTTP surface: the served folder's own paths, plus query-string views of them that no folder path can shadow.

import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { neighbours, renderable } from "./files.ts";
import { shell } from "./shell.ts";
import { fileVersion, folderState, pageState } from "./versions.ts";

export type Log = (line: string) => void;

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
export function createHandler(root: string, assetsDir: string, log: Log): http.RequestListener {
  return (request, response) => {
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

    const asset = url.searchParams.get("asset");

    if (asset !== null) {
      return serveAsset(request, response, assetsDir, asset);
    }

    if (url.searchParams.has("tree")) {
      const state = folderState(root, urlPath);
      return state ? sendJson(response, state) : notFound(response);
    }

    if (url.searchParams.has("step")) {
      const around = neighbours(root, urlPath);
      return around ? sendJson(response, around) : notFound(response);
    }

    const target = renderable(root, urlPath);

    if (url.searchParams.has("raw")) {
      if (!target || target.kind === "image") {
        return notFound(response);
      }

      const { text, version } = pageState(root, target.file);
      response.setHeader("X-Folio-Version", version);
      return send(response, 200, text, "text/plain; charset=utf-8");
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
      response.setHeader("Content-Security-Policy", PAGE_POLICY);
      return send(
        response,
        200,
        shell(path.posix.basename(urlPath) || path.basename(root), path.basename(root)),
        "text/html; charset=utf-8",
      );
    }

    if (!urlPath.endsWith("/") && folderState(root, urlPath)) {
      response.setHeader("Location", `${url.pathname}/`);
      return send(response, 301, "");
    }

    notFound(response);
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

// Revalidated on every load, so an edited image or an upgraded package shows on the next reload.
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
