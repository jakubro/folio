/**
 * What the reader is looking at now - the page and block under the pointer in each open tab - and the
 * switch that pauses sharing it, with what they read, with agents.
 */

import fs from "node:fs";
import path from "node:path";
import type { Model } from "./model.ts";

export interface Looking {
  page: string;
  block?: { source: string; id: string };
  at: string;
}

const PRESENCES = new WeakMap<Model, Presence>();

export function presenceOf(model: Model): Presence {
  let presence = PRESENCES.get(model);

  if (!presence) {
    presence = new Presence(path.join(model.store, "sharing.json"));
    PRESENCES.set(model, presence);
  }

  return presence;
}

export class Presence {
  readonly #file: string;
  readonly #tabs = new Map<number, Looking>();
  readonly #listeners = new Set<(paused: boolean) => void>();
  #paused: boolean;

  constructor(file: string) {
    this.#file = file;

    try {
      this.#paused = JSON.parse(fs.readFileSync(file, "utf8")).paused === true;
    } catch {
      this.#paused = false;
    }
  }

  get paused(): boolean {
    return this.#paused;
  }

  pause(paused: boolean): void {
    if (paused === this.#paused) {
      return;
    }

    this.#paused = paused;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(this.#file, JSON.stringify({ paused }));

    for (const listener of this.#listeners) {
      listener(paused);
    }
  }

  listen(listener: (paused: boolean) => void): void {
    this.#listeners.add(listener);
  }

  look(tab: number, looking: Looking | undefined): void {
    if (looking) {
      this.#tabs.set(tab, looking);
    } else {
      this.#tabs.delete(tab);
    }
  }

  looking(): Looking[] {
    return [...this.#tabs.values()].sort((a, b) => b.at.localeCompare(a.at));
  }
}
