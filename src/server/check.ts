/** `folio check`: a folder's health printed, failing when a problem counts as an error. */

import http from "node:http";
import type { Data } from "./data.ts";
import { healthOf, type Problem } from "./health.ts";
import type { Reach } from "./mcp.ts";
import type { Model } from "./model.ts";

export interface Opened {
  model: Model;
  data: Data;
  close(): Promise<void>;
}

const ASK_MS = 1000;
const POLL_MS = 500;

/** `root` is a real path: a running folio is asked only when the root it reports is the same. */
export async function check(
  root: string,
  reach: Reach,
  open: (root: string) => Opened,
  print: (line: string) => void,
): Promise<number> {
  let problems: Problem[];

  try {
    problems = (await fromRunning(root, reach)) ?? (await standalone(root, open));
  } catch (error) {
    print(`folio check: no health could be worked out: ${(error as Error).message}`);
    return 2;
  }

  const errors = problems.filter((problem) => problem.severity === "error");

  for (const { path, line, severity, kind, what } of problems) {
    print(`${path}:${line} ${severity ?? "-"} ${kind} ${what}`);
  }

  print(
    `folio check: ${count(errors.length, "error")}, ${count(problems.length - errors.length, "other problem")}`,
  );

  return errors.length > 0 ? 1 : 0;
}

async function fromRunning(root: string, reach: Reach): Promise<Problem[] | undefined> {
  const index = (await ask(reach, "/?api").catch(() => undefined)) as { root?: string } | undefined;

  if (index?.root !== root) {
    return undefined;
  }

  for (;;) {
    const health = (await ask(reach, "/?api=health", 0)) as {
      ready: boolean;
      problems: Problem[];
    };

    if (health.ready) {
      return health.problems;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function standalone(root: string, open: (root: string) => Opened): Promise<Problem[]> {
  const { model, data, close } = open(root);

  try {
    await model.start();
    const health = healthOf(model, data);
    const { problems } = await health.state();
    await Promise.all([model.flush(), health.flush()]);
    return problems;
  } finally {
    await close();
  }
}

/** Only finding the folio has a deadline; its health may take as long as checking the folder takes. */
function ask(reach: Reach, address: string, deadline = ASK_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        ...(reach.socket ? { socketPath: reach.socket } : { host: "127.0.0.1", port: reach.port }),
        path: address,
        headers: { host: "localhost" },
        timeout: deadline,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("No answer.")));
    request.on("error", reject);
  });
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
