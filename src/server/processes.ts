/** Whether a process that left something behind is still running, told apart from a later one given its id. */

import fs from "node:fs";

/** When a process started, in the kernel's ticks since boot, where the system tells; "0" elsewhere. */
export function startOf(pid: number | "self"): string {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "0";
  } catch {
    return "0";
  }
}

/** Whether the process `pid` that started at `start` still runs; with no start known, any process of that id. */
export function alive(pid: number, start?: string): boolean {
  return running(pid) && (start === undefined || start === "0" || startOf(pid) === start);
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
