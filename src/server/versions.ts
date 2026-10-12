// Versions of what a tab shows, so a reconnecting tab learns exactly what changed while it was away.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { type Entry, listing } from "./files.ts";
import { expand } from "./includes.ts";

export interface PageState {
  text: string;
  files: string[];
  version: string;
}

export interface FolderState {
  entries: Entry[];
  version: string;
}

export function pageState(root: string, file: string): PageState {
  const { text, files } = expand(root, file);

  return { text, files, version: hash(text) };
}

export function folderState(root: string, urlPath: string): FolderState | undefined {
  const entries = listing(root, urlPath);

  return entries && { entries, version: hash(JSON.stringify(entries)) };
}

export function fileVersion(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}`;
  } catch {
    return undefined;
  }
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}
