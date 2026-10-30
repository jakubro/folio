/** GitHub's inline math written between backticks, `` $`...`$ ``, read as the same node `$...$` makes. */

import type { Data, Processor } from "unified"

type Syntax = NonNullable<Data["micromarkExtensions"]>[number]
type Construct = Extract<NonNullable<Syntax["text"]>[number], { tokenize: unknown }>
type Tokenizer = Construct["tokenize"]
type Effects = Parameters<Tokenizer>[0]
type State = Parameters<Tokenizer>[1]
type Code = Parameters<State>[0]
type Tree = Exclude<NonNullable<Data["fromMarkdownExtensions"]>[number], unknown[]>
type Handle = NonNullable<NonNullable<Tree["enter"]>[string]>
type TokenType = Parameters<Effects["enter"]>[0]

interface InlineMath {
  type: "inlineMath"
  value: string
  data: { hName: string; hProperties: object; hChildren: { type: "text"; value: string }[] }
}

const DOLLAR = 36
const BACKTICK = 96

const MATH = "mathBacktick" as TokenType
const SEQUENCE = "mathBacktickSequence" as TokenType
const DATA = "mathBacktickData" as TokenType
const CODE = "mathBacktickCode" as TokenType
const EDGE = /^(?:\r\n|[ \r\n])|(?:\r\n|[ \r\n])$/g
const construct: Construct = { name: MATH, tokenize }
const broken: Construct = { name: "mathBacktickBroken", tokenize: brokenForm }
const dollar: Construct = { name: "mathBacktickDollar", tokenize: literal }

/** Registered after remark-math: a later extension's construct for `$` is tried first. */
export function backticks(this: Processor): void {
  const data = this.data()

  data.micromarkExtensions = [
    ...(data.micromarkExtensions ?? []),
    { text: { [DOLLAR]: [construct, broken, dollar] } },
  ]
  data.fromMarkdownExtensions = [
    ...(data.fromMarkdownExtensions ?? []),
    {
      enter: { [MATH]: enter, [CODE]: enterCode },
      exit: { [MATH]: exit, [DATA]: text, [CODE]: exitCode },
    },
  ]
}

function tokenize(effects: Effects, ok: State, nok: State): State {
  let opening = 0

  const openTicks = (code: Code): State | undefined => {
    if (code === BACKTICK) {
      effects.consume(code)
      opening++
      return openTicks
    }

    if (opening === 0) {
      return nok(code)
    }

    effects.exit(SEQUENCE)

    if (code === null || ending(code) || code === BACKTICK) {
      return nok(code)
    }

    effects.enter(DATA)
    return content(code)
  }

  const content = (code: Code): State | undefined => {
    if (code === null || ending(code)) {
      return nok(code)
    }

    if (code === BACKTICK) {
      return effects.check({ tokenize: closing }, closed, inner)(code)
    }

    effects.consume(code)
    return content
  }

  const inner = (code: Code): State | undefined => {
    if (code === BACKTICK) {
      effects.consume(code)
      return inner
    }

    return content(code)
  }

  const closed = (code: Code): State | undefined => {
    effects.exit(DATA)
    effects.enter(SEQUENCE)
    return closeTicks(code)
  }

  const closeTicks = (code: Code): State | undefined => {
    effects.consume(code)

    if (code === BACKTICK) {
      return closeTicks
    }

    effects.exit(SEQUENCE)
    effects.exit(MATH)
    return ok
  }

  function closing(this: unknown, check: Effects, found: State, missed: State): State {
    let length = 0

    const run = (code: Code): State | undefined => {
      if (code === BACKTICK) {
        check.consume(code)
        length++
        return run
      }

      return length === opening && code === DOLLAR ? found(code) : missed(code)
    }

    return run as State
  }

  return ((code: Code) => {
    effects.enter(MATH)
    effects.enter(SEQUENCE)
    effects.consume(code)
    return openTicks
  }) as State
}

/** A form broken across lines takes both dollars: a free closing one would pair with the next `$`. */
function brokenForm(effects: Effects, ok: State, nok: State): State {
  let opening = 0

  const openTicks = (code: Code): State | undefined => {
    if (code === BACKTICK) {
      effects.consume(code)
      opening++
      return openTicks
    }

    if (opening === 0) {
      return nok(code)
    }

    effects.exit(SEQUENCE)
    return between(code)
  }

  const between = (code: Code): State | undefined => {
    if (code === null) {
      return nok(code)
    }

    if (ending(code)) {
      effects.enter("lineEnding")
      effects.consume(code)
      effects.exit("lineEnding")
      return between
    }

    if (code === BACKTICK) {
      return effects.check({ tokenize: closing }, closed, ticks)(code)
    }

    effects.enter(DATA)
    return data(code)
  }

  const data = (code: Code): State | undefined => {
    if (code === null || ending(code) || code === BACKTICK) {
      effects.exit(DATA)
      return between(code)
    }

    effects.consume(code)
    return data
  }

  const ticks = (code: Code): State | undefined => {
    effects.enter(DATA)
    return tickData(code)
  }

  const tickData = (code: Code): State | undefined => {
    if (code === BACKTICK) {
      effects.consume(code)
      return tickData
    }

    effects.exit(DATA)
    return between(code)
  }

  const closed = (code: Code): State | undefined => {
    effects.enter(SEQUENCE)
    return closeTicks(code)
  }

  const closeTicks = (code: Code): State | undefined => {
    if (code === BACKTICK) {
      effects.consume(code)
      return closeTicks
    }

    effects.exit(SEQUENCE)
    effects.exit(CODE)
    effects.enter("data")
    effects.consume(code)
    effects.exit("data")
    return ok
  }

  function closing(this: unknown, check: Effects, found: State, missed: State): State {
    let length = 0

    const count = (code: Code): State | undefined => {
      if (code === BACKTICK) {
        check.consume(code)
        length++
        return count
      }

      return length === opening && code === DOLLAR ? found(code) : missed(code)
    }

    return count as State
  }

  return ((code: Code) => {
    effects.enter("data")
    effects.consume(code)
    effects.exit("data")
    effects.enter(CODE)
    effects.enter(SEQUENCE)
    return openTicks
  }) as State
}

/** A `$` before a backtick that opens no formula on its line is a dollar sign, never the start of `$...$`. */
function literal(effects: Effects, ok: State, nok: State): State {
  const after = (code: Code): State | undefined => (code === BACKTICK ? ok(code) : nok(code))

  return ((code: Code) => {
    effects.enter("data")
    effects.consume(code)
    effects.exit("data")
    return after
  }) as State
}

/** micromark marks every line ending with a negative code below -2, and the end of input with null. */
function ending(code: Code): boolean {
  return code !== null && code < -2
}

const enter: Handle = function (token) {
  const node: InlineMath = {
    type: "inlineMath",
    value: "",
    data: {
      hName: "code",
      hProperties: { className: ["language-math", "math-inline"] },
      hChildren: [],
    },
  }

  this.enter(node as never, token)
  this.buffer()
}

const text: Handle = function (token) {
  this.config.enter.data.call(this, token)
  this.config.exit.data.call(this, token)
}

const exit: Handle = function (token) {
  const value = this.resume().trim()
  const node = this.stack.at(-1) as InlineMath

  this.exit(token)
  node.value = value
  node.data.hChildren.push({ type: "text", value })
}

const enterCode: Handle = function (token) {
  this.enter({ type: "inlineCode", value: "" } as never, token)
  this.buffer()
}

/** As a code span: one space or line ending is dropped from each end when both have one. */
const exitCode: Handle = function (token) {
  const value = this.resume()
  const node = this.stack.at(-1) as { value: string }

  this.exit(token)
  node.value =
    value.trim() !== "" && /^(?:\r\n|[ \r\n])/.test(value) && /(?:\r\n|[ \r\n])$/.test(value)
      ? value.replace(EDGE, "")
      : value
}
