/** Reading: a block counts as read once it has stayed on screen for a moment while the tab is shown. */

export interface ReadBlock {
  source: string;
  id: string;
  version: string;
  embeds?: Record<string, string>;
}

const DWELL_MS = 1500;
const SHOWN = 0.5;

export class Reading {
  onRead: (blocks: ReadBlock[]) => void = () => {};
  held: (block: HTMLElement) => boolean = () => false;
  embedsOf: (block: HTMLElement) => Record<string, string> = () => ({});
  /** Where in a block, as fractions of its height, the change it is marked for lies. */
  changedSpan: (block: HTMLElement) => [number, number] | undefined = () => undefined;
  readonly #observer = new IntersectionObserver((entries) => this.#seen(entries));
  readonly #timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  readonly #watched = new Set<HTMLElement>();
  readonly #touching = new Set<HTMLElement>();
  #measuring = false;
  readonly #onScreen = new Set<HTMLElement>();
  readonly #read = new WeakMap<HTMLElement, string>();
  readonly #covered = new WeakMap<HTMLElement, { shows: string; spans: [number, number][] }>();

  constructor() {
    for (const type of ["scroll", "resize"]) {
      addEventListener(type, () => this.#schedule(), { passive: true });
    }

    document.addEventListener("visibilitychange", () => {
      for (const block of this.#onScreen) {
        this.#time(block);
      }
    });
  }

  watch(blocks: HTMLElement[]): void {
    const wanted = new Set(blocks);

    for (const block of this.#watched) {
      if (!wanted.has(block)) {
        this.#observer.unobserve(block);
        this.#watched.delete(block);
        this.#touching.delete(block);
        this.#stop(block);
      }
    }

    for (const block of wanted) {
      if (!this.#watched.has(block)) {
        this.#observer.observe(block);
        this.#watched.add(block);
      }
    }

    // A block kept in place through an edit that left its look alone gets no new intersection.
    for (const block of this.#onScreen) {
      if (!this.#timers.has(block)) {
        this.#time(block);
      }
    }
  }

  /**
   * The observer says only which blocks touch the window; how much shows is measured on each scroll,
   * since a block many windows tall crosses no fraction of its own height while it is read.
   */
  #seen(entries: IntersectionObserverEntry[]): void {
    for (const { target, isIntersecting } of entries) {
      const block = target as HTMLElement;

      if (isIntersecting) {
        this.#touching.add(block);
      } else {
        this.#touching.delete(block);
      }
    }

    this.#measure();
  }

  #measure(): void {
    for (const block of this.#touching) {
      const { top, bottom, height } = block.getBoundingClientRect();
      const visible = Math.min(bottom, innerHeight) - Math.max(top, 0);
      // A block taller than the window is on screen once it fills half of it.
      const shown = visible > 0 && (visible >= height * SHOWN || visible >= innerHeight * SHOWN);

      if (shown && !this.#onScreen.has(block)) {
        this.#onScreen.add(block);
        this.#time(block);
      } else if (!shown && this.#onScreen.has(block)) {
        this.#stop(block);
      }
    }

    for (const block of this.#onScreen) {
      if (!this.#touching.has(block)) {
        this.#stop(block);
      }
    }
  }

  #schedule(): void {
    if (!this.#measuring) {
      this.#measuring = true;
      requestAnimationFrame(() => {
        this.#measuring = false;
        this.#measure();
      });
    }
  }

  #time(block: HTMLElement): void {
    clearTimeout(this.#timers.get(block));
    this.#timers.delete(block);

    if (document.visibilityState !== "visible" || this.#read.get(block) === this.#shows(block)) {
      return;
    }

    const due = Date.now() + DWELL_MS;

    this.#timers.set(
      block,
      setTimeout(() => {
        this.#timers.delete(block);
        const { folioSource: source, folioId: id, folioVersion: version } = block.dataset;

        // A timer firing long after it was due slept with its machine: nothing was on screen meanwhile.
        if (Date.now() - due > DWELL_MS || this.held(block) || !this.#seenChange(block)) {
          this.#time(block);
        } else if (source && id && version && block.isConnected) {
          const embeds = this.embedsOf(block);
          this.#read.set(block, this.#shows(block));
          this.onRead([{ source, id, version, ...(Object.keys(embeds).length > 0 && { embeds }) }]);
        }
      }, DWELL_MS),
    );
  }

  /** A change marked in a block taller than the window is read only once its part has been on screen. */
  #seenChange(block: HTMLElement): boolean {
    const { top, height } = block.getBoundingClientRect();
    const span = height > innerHeight ? this.changedSpan(block) : undefined;

    if (!span) {
      return true;
    }

    const shows = this.#shows(block);
    const held = this.#covered.get(block);
    const spans = held?.shows === shows ? held.spans : [];
    spans.push([Math.max(0, -top), Math.min(height, innerHeight - top)]);
    this.#covered.set(block, { shows, spans });

    const [from, to] = [span[0] * height, Math.max(span[1] * height, span[0] * height + 1)];
    let reached = from;

    for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
      if (end > reached && start <= reached + 1) {
        reached = end;
      }
    }

    return reached >= to - 1;
  }

  /** What a block shows: its text's version and its embeds' data, either of which makes it new again. */
  #shows(block: HTMLElement): string {
    return JSON.stringify([block.dataset.folioVersion, this.embedsOf(block)]);
  }

  #stop(block: HTMLElement): void {
    clearTimeout(this.#timers.get(block));
    this.#timers.delete(block);
    this.#onScreen.delete(block);
  }
}
