/** Vega-Lite charts drawn from the folder's data, as SVG. */

import { parse as parseYaml } from "yaml";
import type { Embedded } from "../server/data.ts";
import { cycleIn } from "./cycles.ts";
import { rowsOf } from "./embeds.ts";
import type { Theme } from "./render.ts";

const FONT = "Arimo";
const THEMES = {
  light: { font: FONT },
  dark: {
    font: FONT,
    axis: {
      labelColor: "#cccccc",
      titleColor: "#cccccc",
      gridColor: "#363636",
      domainColor: "#808080",
      tickColor: "#808080",
    },
    legend: { labelColor: "#cccccc", titleColor: "#cccccc" },
    title: { color: "#cccccc" },
    header: { labelColor: "#cccccc", titleColor: "#cccccc" },
    view: { stroke: "#363636" },
  },
};

export async function chartOf(
  element: HTMLElement,
  theme: Theme,
  fetchEmbed: (reference: string) => Promise<Embedded>,
): Promise<HTMLElement> {
  const source = element.querySelector("pre")?.textContent ?? "";
  const [spec, vegaLite, vega, { expressionInterpreter }] = await Promise.all([
    chartSpec(source, fetchEmbed),
    import("vega-lite"),
    import("vega"),
    import("vega-interpreter"),
  ]);

  await Promise.all(["11px", "bold 11px"].map((font) => document.fonts.load(`${font} ${FONT}`)));

  // Parsed to an expression tree and interpreted: the page's policy forbids the code Vega would compile.
  const runtime = vega.parse(vegaLite.compile(spec as never).spec, THEMES[theme] as never, {
    ast: true,
  });
  // Vega drops a link its loader refuses, such as a javascript: one, by throwing where nothing catches.
  const loader = vega.loader();
  const sanitize = loader.sanitize.bind(loader);
  loader.sanitize = (uri, options) => sanitize(uri, options).catch(() => ({ href: "" }));
  const view = new vega.View(runtime, {
    renderer: "none",
    expr: expressionInterpreter as never,
    loader,
  });
  const chart = element.ownerDocument.createElement("div");

  view.background("transparent");
  chart.className = "chart";
  chart.innerHTML = await view.toSVG();
  view.finalize();
  return chart;
}

/** A chart's Vega-Lite description with every `data.url` replaced by the rows it names. */
export async function chartSpec(
  source: string,
  fetchEmbed: (reference: string) => Promise<Embedded>,
): Promise<Record<string, unknown>> {
  const spec = parseSpec(source);
  await resolveData(spec, fetchEmbed);
  return spec;
}

function parseSpec(source: string): Record<string, unknown> {
  let spec: unknown;

  try {
    spec = JSON.parse(source);
  } catch {
    spec = parseYaml(source);
  }

  if (spec === null || typeof spec !== "object") {
    throw new Error("A chart is described by a Vega-Lite object, in JSON or YAML.");
  }

  const loop = cycleIn(spec);

  if (loop !== undefined) {
    throw new Error(`The chart description refers to itself at ${loop}.`);
  }

  return spec as Record<string, unknown>;
}

async function resolveData(
  node: unknown,
  fetchEmbed: (reference: string) => Promise<Embedded>,
): Promise<void> {
  if (node === null || typeof node !== "object") {
    return;
  }

  const record = node as Record<string, unknown>;
  const data = record.data as { url?: unknown } | undefined;

  if (data && typeof data.url === "string") {
    const { url, ...rest } = data;
    record.data = { ...rest, values: rowsOf(await fetchEmbed(url)) };
  }

  await Promise.all(
    Object.entries(record)
      .filter(([key]) => key !== "data")
      .map(([, value]) => resolveData(value, fetchEmbed)),
  );
}
