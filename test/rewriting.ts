/** Another program rewriting a file in place: it empties the file at once and writes its text after a pause. */

import { type ChildProcess, spawn } from "node:child_process"

const REWRITE = `const fs = require("node:fs")
const handle = fs.openSync(process.argv[1], "w")
process.stdout.write("open")
setTimeout(() => { fs.writeSync(handle, process.argv[2]); fs.closeSync(handle) }, Number(process.argv[3]))`

export async function rewriting(file: string, text: string, pauseMs = 400): Promise<ChildProcess> {
  const rewriter = spawn(process.execPath, ["-e", REWRITE, file, text, String(pauseMs)])
  await new Promise((resolve) => rewriter.stdout.once("data", resolve))
  return rewriter
}
