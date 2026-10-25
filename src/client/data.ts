/** A data file's page: its rows as a table, a nested document as a tree that folds, a database as its tables. */

import type { Cell, DataPage, DataTable, Grid } from "../server/data.ts";

const RECORDS_AT_MOST = 5000;
const OPEN_DEPTH = 2;
/** The items of a longer list start folded, so opening the page builds one line per item. */
const CROWDED = 1000;
const BATCH = 1000;
const NUMBER = new Intl.NumberFormat("en");

export async function fetchData(urlPath: string, table?: string): Promise<DataPage | undefined> {
  const query = table === undefined ? "?data" : `?data&table=${encodeURIComponent(table)}`;
  const response = await fetch(`/${urlPath.split("/").map(encodeURIComponent).join("/")}${query}`);
  return response.ok ? response.json() : undefined;
}

export function dataArticle(urlPath: string, page: DataPage | undefined): HTMLElement {
  const article = document.createElement("article");
  const name = urlPath.split("/").pop() ?? urlPath;

  article.className = "markdown-body data-page";
  article.append(heading("h1", page?.table ?? name));

  if (!page) {
    article.append(paragraph("Nothing to show.", "data-info"));
    return article;
  }

  article.append(paragraph(about(page), "data-info"));

  if (page.table !== undefined) {
    const back = document.createElement("a");
    back.href = `/${urlPath.split("/").map(encodeURIComponent).join("/")}`;
    back.textContent = `All tables of ${name}`;
    article.append(paragraphOf(back, "data-info"));
  }

  if (page.format === "sql" && page.text !== undefined) {
    const pre = document.createElement("pre");
    const code = pre.appendChild(document.createElement("code"));
    code.className = "language-sql";
    code.textContent = page.text;
    article.append(pre);
  }

  if (page.error) {
    article.append(paragraph(page.error, "data-error"));
  }

  if (page.grid) {
    article.append(gridTable(page.grid));
  }

  if (page.tables) {
    article.append(...databaseTables(urlPath, page.tables));
  }

  if (page.value !== undefined) {
    article.append(...nested(page.value));
  }

  if (page.text !== undefined && page.format !== "sql") {
    const pre = document.createElement("pre");
    pre.textContent = page.text;
    article.append(pre);
  }

  return article;
}

export function gridTable(grid: Grid): HTMLTableElement {
  const element = document.createElement("table");
  const head = element.createTHead().insertRow();
  const body = element.createTBody();

  for (const { name, type } of grid.columns) {
    const cell = document.createElement("th");
    cell.textContent = name;
    cell.title = type;
    head.append(cell);
  }

  for (const row of grid.rows) {
    const line = body.insertRow();

    for (const value of row) {
      line.insertCell().textContent = text(value);
    }
  }

  return element;
}

export function recordsOf(value: unknown): Grid | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
  ) {
    return undefined;
  }

  const shown = value.slice(0, RECORDS_AT_MOST);
  const names = [...new Set(shown.flatMap((item) => Object.keys(item)))];

  return {
    columns: names.map((name) => ({ name, type: "" })),
    rows: shown.map((item) => names.map((name) => cellOf(item[name]))),
    total: value.length,
    partial: shown.length < value.length,
  };
}

function about(page: DataPage): string {
  const parts = [page.format.toUpperCase(), size(page.size)];
  const grid = page.grid;

  if (grid?.partial && grid.total === undefined) {
    parts.push(`showing its first ${NUMBER.format(grid.rows.length)} rows`);
  } else if (grid?.partial && grid.total !== undefined) {
    parts.push(
      `showing the first ${NUMBER.format(grid.rows.length)} of ${NUMBER.format(grid.total)} rows`,
    );
  } else if (grid) {
    parts.push(`${NUMBER.format(grid.rows.length)} ${grid.rows.length === 1 ? "row" : "rows"}`);
  }

  if (page.tables) {
    parts.push(`${page.tables.length} ${page.tables.length === 1 ? "table" : "tables"}`);
  }

  if (page.text !== undefined && !page.error && page.format !== "sql") {
    parts.push(`too large to show whole; showing its start`);
  }

  if (page.note) {
    parts.push(page.note);
  }

  return parts.join(" · ");
}

function databaseTables(urlPath: string, tables: DataTable[]): HTMLElement[] {
  if (tables.length === 0) {
    return [paragraph("This database holds no tables.", "data-info")];
  }

  return tables.flatMap((found) => {
    const open = document.createElement("a");
    const columns = found.columns.map(({ name, type }) => `${name} ${type}`).join(", ");

    open.href = `/${urlPath.split("/").map(encodeURIComponent).join("/")}?table=${encodeURIComponent(found.name)}`;
    open.textContent = "Open the whole table";

    const info = paragraph(
      `${NUMBER.format(found.total)} ${found.total === 1 ? "row" : "rows"} · ${columns} · `,
      "data-info",
    );
    info.append(open);
    if (found.error) {
      return [heading("h2", found.name), paragraph(found.error, "data-error")];
    }

    return [heading("h2", found.name), info, gridTable(found.first)];
  });
}

function nested(value: unknown): HTMLElement[] {
  const records = recordsOf(value);

  if (!records) {
    return [tree(value, 0)];
  }

  const asTable = document.createElement("div");
  const asTree = tree(value, 0);

  asTable.append(
    ...(records.partial
      ? [
          paragraph(
            `The first ${NUMBER.format(records.rows.length)} of ${NUMBER.format(records.total ?? 0)} records; the tree holds them all.`,
            "data-info",
          ),
        ]
      : []),
    gridTable(records),
  );
  const switcher = document.createElement("p");
  // A list longer than the table holds opens as the tree, which holds all of it.
  const first = records.partial ? "Tree" : "Table";
  const choices = (["Table", "Tree"] as const).map((label) => {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.textContent = label;
    choice.className = "data-switch";
    choice.setAttribute("aria-pressed", String(label === first));
    choice.addEventListener("click", () => {
      asTable.hidden = label !== "Table";
      asTree.hidden = label !== "Tree";

      for (const other of choices) {
        other.setAttribute("aria-pressed", String(other === choice));
      }
    });
    return choice;
  });

  switcher.className = "data-info";
  switcher.append(...choices);
  asTable.hidden = first !== "Table";
  asTree.hidden = first !== "Tree";
  return [switcher, asTable, asTree];
}

function tree(value: unknown, depth: number, key?: string, crowded = false): HTMLElement {
  const label = key === undefined ? "" : `${key}: `;

  if (value === null || typeof value !== "object") {
    const leaf = document.createElement("div");
    const shown = document.createElement("span");

    leaf.className = "data-leaf";
    shown.className = `data-${value === null ? "null" : typeof value}`;
    shown.textContent = JSON.stringify(value) ?? String(value);
    leaf.append(document.createTextNode(label), shown);
    return leaf;
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const branch = document.createElement("details");
  const summary = document.createElement("summary");
  const count = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;

  // A branch draws its children when first opened, a batch at a time.
  // A list of a hundred thousand items is neither built at once nor spread into one call, overflowing the stack.
  let drawn = 0;
  const more = document.createElement("button");
  const fill = () => {
    const end = Math.min(entries.length, drawn + BATCH);

    for (; drawn < end; drawn++) {
      const [name, item] = entries[drawn];
      branch.insertBefore(tree(item, depth + 1, name, entries.length > CROWDED), more);
    }

    if (drawn === entries.length) {
      more.remove();
    } else {
      more.textContent = `Show ${NUMBER.format(Math.min(BATCH, entries.length - drawn))} more of ${NUMBER.format(entries.length)}`;
    }
  };

  more.type = "button";
  more.className = "data-switch data-more";
  more.addEventListener("click", fill);

  branch.className = "data-tree";
  summary.textContent = `${label}${count}`;
  branch.append(summary, more);

  if (depth < OPEN_DEPTH && !crowded) {
    branch.open = true;
    fill();
  } else {
    branch.addEventListener("toggle", fill, { once: true });
  }

  return branch;
}

function cellOf(value: unknown): Cell {
  return value === undefined
    ? null
    : value === null || ["string", "number", "boolean"].includes(typeof value)
      ? (value as Cell)
      : JSON.stringify(value);
}

function text(value: Cell): string {
  return value === null ? "" : String(value);
}

function size(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let scaled = bytes;
  let unit = 0;

  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }

  return unit === 0 ? `${bytes} bytes` : `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${units[unit]}`;
}

function heading(tag: "h1" | "h2", content: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = content;
  element.id = content;
  return element;
}

function paragraph(content: string, className: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = content;
  return element;
}

function paragraphOf(child: Node, className: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = className;
  element.append(child);
  return element;
}
