/** The embedding model's worker thread: fetches the runtime and the model once, then turns texts into vectors. */

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import module from "node:module"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import { parentPort } from "node:worker_threads"

interface Session {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>
}

interface Runtime {
  InferenceSession: {
    create(file: string, options: object): Promise<Session>
  }
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown
}

interface Tokenizer {
  encode(text: string): { ids: number[] }
}

type Request =
  | { type: "prepare"; cache: string }
  | { type: "embed"; id: number; texts: string[]; query: boolean }

const RUNTIME = ["onnxruntime-node@1.31.1", "@huggingface/tokenizers@0.2.0"]
const REPOSITORY = "onnx-community/embeddinggemma-300m-ONNX"
const REVISION = "5090578d9565bb06545b4552f76e6bc2c93e4a66"
const FILES = [
  {
    name: "onnx/model.onnx",
    size: 479_932,
    sha256: "ea91fd315a7c152d427d231746f0f811a1ac93beaba656abfdf2b24e091265e4",
  },
  {
    name: "onnx/model.onnx_data",
    size: 1_234_521_088,
    sha256: "ef835ae565d8695236652475903078e8ed794c7c35faf1164d78ec3238e8a88d",
  },
  {
    name: "tokenizer.json",
    size: 20_323_312,
    sha256: "4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47",
  },
  {
    name: "tokenizer_config.json",
    size: 1_156_830,
    sha256: "3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a",
  },
]
const DOCUMENT = "title: none | text: "
const QUERY = "task: search result | query: "
const MAX_TOKENS = 512
const DIMENSIONS = 768
const THREADS = Math.min(4, Math.max(1, os.availableParallelism() >> 1))
const LOWEST = 19
const run = promisify(execFile)

let model: { runtime: Runtime; session: Session; tokenizer: Tokenizer } | undefined
let work = Promise.resolve()

parentPort?.on("message", (request: Request) => {
  work = work.then(() => answer(request))
})

async function answer(request: Request): Promise<void> {
  try {
    if (request.type === "prepare") {
      model ??= await prepare(request.cache)
      parentPort?.postMessage({ type: "ready" })
    } else {
      const vectors = await embed(request.texts, request.query)
      parentPort?.postMessage({ type: "embedded", id: request.id, vectors }, [
        vectors.buffer as ArrayBuffer,
      ])
    }
  } catch (error) {
    parentPort?.postMessage({
      type: "failed",
      ...(request.type === "embed" && { id: request.id }),
      message: (error as Error).message,
    })
  }
}

async function prepare(cache: string): Promise<NonNullable<typeof model>> {
  const runtimeDir = path.join(cache, "runtime", RUNTIME.join("+").replaceAll("/", "-"))
  const modelDir = path.join(cache, "models", `embeddinggemma-300m-${REVISION.slice(0, 8)}`)

  if (!fs.existsSync(runtimeDir)) {
    parentPort?.postMessage({ type: "progress", status: "installing" })
    await install(runtimeDir)
  }

  await download(modelDir)
  // Before the session: on Linux a nice value is per thread, and the model's threads inherit this one's.
  try {
    os.setPriority(0, LOWEST)
  } catch {}

  const require = module.createRequire(path.join(runtimeDir, "package.json"))
  const runtime = require("onnxruntime-node") as Runtime
  const { Tokenizer } = require("@huggingface/tokenizers") as {
    Tokenizer: new (json: unknown, config: unknown) => Tokenizer
  }
  const json = (name: string) => JSON.parse(fs.readFileSync(path.join(modelDir, name), "utf8"))

  return {
    runtime,
    session: await runtime.InferenceSession.create(path.join(modelDir, "onnx/model.onnx"), {
      intraOpNumThreads: THREADS,
      interOpNumThreads: 1,
    }),
    tokenizer: new Tokenizer(json("tokenizer.json"), json("tokenizer_config.json")),
  }
}

async function install(dir: string): Promise<void> {
  const partial = `${dir}.part-${process.pid}`

  await clearAbandoned(dir)
  await fs.promises.mkdir(partial, { recursive: true })
  await fs.promises.writeFile(path.join(partial, "package.json"), '{"private":true}\n')
  await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", ...RUNTIME],
    { cwd: partial, maxBuffer: 16 << 20, shell: process.platform === "win32" },
  ).catch((error: Error & { stderr?: string }) => {
    throw new Error(
      `npm could not install ${RUNTIME.join(" and ")}: ${error.stderr || error.message}`,
    )
  })
  await fs.promises.rename(partial, dir).catch(async (error: NodeJS.ErrnoException) => {
    await fs.promises.rm(partial, { recursive: true, force: true })

    if (!fs.existsSync(dir)) {
      throw error
    }
  })
}

async function download(dir: string): Promise<void> {
  const missing = FILES.filter(({ name }) => !fs.existsSync(path.join(dir, name)))
  const total = missing.reduce((sum, { size }) => sum + size, 0)
  let done = 0
  let told = 0

  for (const { name, size, sha256 } of missing) {
    const file = path.join(dir, name)
    const partial = `${file}.part-${process.pid}`

    await clearAbandoned(file)
    const response = await fetch(`https://huggingface.co/${REPOSITORY}/resolve/${REVISION}/${name}`)

    if (!response.ok || !response.body) {
      throw new Error(`the model's ${name} could not be downloaded: ${response.status}`)
    }

    const hash = createHash("sha256")
    const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)

    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    body.on("data", (chunk: Buffer) => {
      hash.update(chunk)
      done += chunk.length

      if (done - told >= 4 << 20) {
        told = done
        parentPort?.postMessage({ type: "progress", status: "downloading", done, total })
      }
    })
    await pipeline(body, fs.createWriteStream(partial))

    if ((await fs.promises.stat(partial)).size !== size || hash.digest("hex") !== sha256) {
      await fs.promises.rm(partial, { force: true })
      throw new Error(`the model's ${name} arrived damaged`)
    }

    await fs.promises.rename(partial, file)
  }
}

async function embed(texts: string[], query: boolean): Promise<Float32Array> {
  const { runtime, session, tokenizer } = model as NonNullable<typeof model>
  const encoded = texts.map((text) => {
    const { ids } = tokenizer.encode(`${query ? QUERY : DOCUMENT}${text}`)
    return ids.length > MAX_TOKENS ? [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]] : ids
  })
  const width = Math.max(...encoded.map((ids) => ids.length))
  const ids = new BigInt64Array(texts.length * width)
  const mask = new BigInt64Array(texts.length * width)

  for (const [row, tokens] of encoded.entries()) {
    for (const [column, id] of tokens.entries()) {
      ids[row * width + column] = BigInt(id)
      mask[row * width + column] = 1n
    }
  }

  const { sentence_embedding } = await session.run({
    input_ids: new runtime.Tensor("int64", ids, [texts.length, width]),
    attention_mask: new runtime.Tensor("int64", mask, [texts.length, width]),
  })

  return sentence_embedding.data.slice(0, texts.length * DIMENSIONS)
}

async function clearAbandoned(target: string): Promise<void> {
  const prefix = `${path.basename(target)}.part-`
  const names = await fs.promises.readdir(path.dirname(target)).catch(() => [])

  for (const name of names.filter((one) => one.startsWith(prefix))) {
    const pid = Number(name.slice(prefix.length))

    if (Number.isInteger(pid) && !running(pid)) {
      await fs.promises.rm(path.join(path.dirname(target), name), { recursive: true, force: true })
    }
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
