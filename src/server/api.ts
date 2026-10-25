/** The read-only model API: what folio knows of the folder, as JSON, for agents and other tools. */

import path from "node:path";
import { conventionsOf } from "./conventions.ts";
import type { Data } from "./data.ts";
import { digest } from "./digest.ts";
import { isDocument, renderable } from "./files.ts";
import { healthOf } from "./health.ts";
import { impactOf } from "./impact.ts";
import type { Model } from "./model.ts";
import { needsOf } from "./needs.ts";
import { presenceOf } from "./presence.ts";
import { provenance } from "./provenance.ts";
import { staleOf } from "./stale.ts";
import { changesState, pageState, readState } from "./versions.ts";

export class Refusal extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Resource = (asked: Asked) => Promise<unknown> | unknown;

interface Asked {
  root: string;
  model: Model;
  data: Data;
  /** The path the request names, relative to the served folder; "" for the folder itself. */
  urlPath: string;
  query: URLSearchParams;
}

const DAY_MS = 86_400_000;
const EXCERPT = 300;
const SHARED = new Set(["reads", "changes", "needs", "presence", "stale"]);

export const PAUSED = {
  paused: true,
  message: "The reader has paused sharing in folio: what they read and look at is not shared.",
};

export const RESOURCES: Record<string, { address: string; answers: string; read: Resource }> = {
  documents: {
    address: "/<folder>/?api=documents",
    answers: "Every document under the folder, with its kind when a declaration places it",
    read: ({ model, urlPath }) => {
      const prefix = urlPath && !urlPath.endsWith("/") ? `${urlPath}/` : urlPath;
      const conventions = conventionsOf(model);

      return {
        ready: model.ready,
        documents: model
          .paths()
          .filter((found) => found.startsWith(prefix))
          .sort()
          .map((found) => ({ path: found, kind: conventions.kindOf(found) ?? null })),
      };
    },
  },
  document: {
    address: "/<path>?api=document",
    answers:
      "A document's blocks - id, kind, lines, the start of its text - its blocks as its page places them through includes, its kind and fields, and the data files it reads",
    read: async ({ root, model, data, urlPath }) => {
      const file = documentFile(root, urlPath);
      const own = model.inspect(urlPath);

      if (!own) {
        throw new Refusal(503, "folio has not read this document yet.");
      }

      return {
        ...own,
        page: pageState(root, file, model).blocks,
        conventions: conventionsOf(model).describe(urlPath),
        data: await data.dependencies(file),
      };
    },
  },
  provenance: {
    address: "/<path>?api=provenance&block=<id>[&source=<file>]",
    answers:
      "Where one block of the page came from: its file, lines, last change, data and figures",
    read: async ({ root, model, data, urlPath, query }) => {
      const file = documentFile(root, urlPath);
      const found = await provenance(
        root,
        model,
        data,
        pageState(root, file, model),
        urlPath,
        query.get("source") ?? urlPath,
        required(query, "block"),
      );

      if (!found) {
        throw new Refusal(404, "No such block on this page.");
      }

      return found;
    },
  },
  query: {
    address: "/<folder>/?api=query&sql=<select>",
    answers:
      "The result of one SELECT, run from the folder as a query in it runs, reading data files and the document tables",
    read: async ({ root, data, urlPath, query }) => {
      const { grid, files } = await data
        .query(required(query, "sql"), path.join(root, urlPath))
        .catch((error: Error) => {
          throw new Refusal(400, error.message);
        });
      return { ...grid, files };
    },
  },
  embed: {
    address: "/<path>?api=embed&reference=<reference>",
    answers:
      "What a reference written in the document names - a file's rows, a value, a query's result",
    read: ({ root, data, urlPath, query }) =>
      data.embedReference(documentFile(root, urlPath), required(query, "reference")),
  },
  kinds: {
    address: "/<path>?api=kinds",
    answers:
      "The kinds, rules and health entries applying at a path, layered as the declarations layer them",
    read: ({ model, urlPath }) => {
      const { kinds, rules, health } = conventionsOf(model).layered(urlPath);
      const from = ({ from: declared }: { from: { path: string } }) => declared.path;

      return {
        declarations: conventionsOf(model)
          .applying(urlPath)
          .map((declaration) => declaration.path),
        kinds: kinds.map((kind) => ({
          name: kind.name,
          declaredIn: from(kind),
          where: kind.definition.where.map(String),
          fields: kind.definition.fields,
        })),
        rules: rules.map((rule) => ({
          name: rule.name,
          declaredIn: from(rule),
          ...rule.definition,
        })),
        health: health.map((entry) => ({
          declaredIn: from(entry),
          where: entry.definition.where.map(String),
          skip: entry.definition.skip,
          error: entry.definition.error,
        })),
      };
    },
  },
  health: {
    address: "/?api=health",
    answers:
      "Everything wrong in the folder - each problem's kind, document, line, block, severity and what is wrong",
    read: ({ model, data }) => healthOf(model, data).state(),
  },
  presence: {
    address: "/?api=presence",
    answers:
      "What the reader is looking at now: the page in each open tab and the block under the pointer, with the start of its text, the most recent first",
    read: ({ model }) => ({
      paused: false,
      looking: presenceOf(model)
        .looking()
        .map((looking) => {
          const text = looking.block
            ? model.held(looking.block.source)?.find(({ id }) => id === looking.block?.id)?.text
            : undefined;
          return {
            ...looking,
            ...(looking.block &&
              text !== undefined && {
                block: { ...looking.block, text: text.slice(0, EXCERPT) },
              }),
          };
        }),
    }),
  },
  needs: {
    address: "/?api=needs",
    answers:
      "What needs the reader, ranked: errors, problems in documents they read, rows of the folder's attention queries, and changes to what they read",
    read: async ({ model, data }) => {
      const { ready, needs, version } = await needsOf(model, data);
      return { ready, needs, version };
    },
  },
  stale: {
    address: "/?api=stale",
    answers:
      "Documents that have probably outlived their use - by default unchanged for a year, never read and linked from nowhere, or what a folder's stale query names - each with when it last changed and why",
    read: async ({ model, data }) => {
      const { ready, documents, version } = await staleOf(model, data);
      return { ready, documents, version };
    },
  },
  changes: {
    address: "/?api=changes",
    answers: "Every document read before whose blocks changed since, newest change first",
    read: ({ root, model, data }) => changesState(root, model, data),
  },
  reads: {
    address: "/?api=reads, /<path>?api=reads",
    answers:
      "Every document read and when it was last read; for a document, each block with its version and the version and time it was read, and what is marked new, changed or removed",
    read: async ({ root, model, data, urlPath }) => {
      await model.reads.load();

      if (!urlPath || urlPath.endsWith("/")) {
        return { documents: model.reads.documents(urlPath) };
      }

      const file = documentFile(root, urlPath);
      return readState(model, urlPath, pageState(root, file, model).blocks, data);
    },
  },
  history: {
    address: "/<path>?api=history[&version=<id>|&block=<id>|&reference=<reference>]",
    answers:
      "A document's versions, newest first; with version, that version's text; with block, each text the block has had; with reference, each result the embed has shown",
    read: async ({ model, urlPath, query }) => {
      const history = model.history;
      const version = query.get("version");
      const block = query.get("block");
      const reference = query.get("reference");

      if (version !== null) {
        return { path: urlPath, version, text: (await history.text(urlPath, version)) ?? null };
      }

      if (block !== null) {
        return {
          path: urlPath,
          block,
          versions: await history.block(urlPath, block, model.held(urlPath) ?? []),
        };
      }

      if (reference !== null) {
        return { path: urlPath, reference, results: await history.values(urlPath, reference) };
      }

      return { path: urlPath, versions: await history.versions(urlPath) };
    },
  },
  "used-by": {
    address: "/<path>?api=used-by",
    answers: "The documents including the file, or whose embeds and queries read it",
    read: async ({ model, data, urlPath }) =>
      model.ready
        ? { ready: true, documents: await impactOf(model, data).dependents(urlPath) }
        : { ready: false, documents: [] },
  },
  digest: {
    address: "/?api=digest[&from=<ms>&to=<ms>]",
    answers:
      "Every document created, changed or removed in a period, and every value that moved; the last day by default",
    read: ({ root, model, query }) => {
      const to = Number(query.get("to") ?? Date.now());
      const from = Number(query.get("from") ?? to - DAY_MS);

      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new Refusal(400, "from and to are times in milliseconds.");
      }

      return digest(root, model, from, to);
    },
  },
};

export async function api(
  root: string,
  model: Model,
  data: Data,
  urlPath: string,
  query: URLSearchParams,
): Promise<unknown> {
  const name = query.get("api") ?? "";

  if (!name) {
    return {
      folio: path.basename(root),
      root,
      ready: model.ready,
      resources: Object.fromEntries(
        Object.entries(RESOURCES).map(([key, { address, answers }]) => [key, { address, answers }]),
      ),
    };
  }

  const resource = RESOURCES[name];

  if (!resource) {
    throw new Refusal(404, `No resource is named ${name}: ?api lists them.`);
  }

  if (SHARED.has(name) && presenceOf(model).paused) {
    return PAUSED;
  }

  return resource.read({ root, model, data, urlPath, query });
}

function documentFile(root: string, urlPath: string): string {
  const target = renderable(root, urlPath);

  if (!target || !isDocument(target.kind)) {
    throw new Refusal(404, `${urlPath || "/"} is no document of the folder.`);
  }

  return target.file;
}

function required(query: URLSearchParams, name: string): string {
  const value = query.get(name);

  if (value === null || value === "") {
    throw new Refusal(400, `This resource needs ${name}.`);
  }

  return value;
}
