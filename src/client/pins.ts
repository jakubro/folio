/** A table's header row kept in sight below the toolbar while its rows scroll past beneath it. */

type ViewTimelineConstructor = new (options: {
  subject: Element
  axis: "block"
  inset: string
}) => AnimationTimeline

interface Pin {
  timeline: AnimationTimeline
  header: Animation
  shade: Animation
}

const ViewTimeline = (globalThis as { ViewTimeline?: ViewTimelineConstructor }).ViewTimeline
const PINS = new WeakMap<HTMLTableElement, Pin>()
const observed = new Set<HTMLTableElement>()
let observer: ResizeObserver | undefined
const followers = new Map<HTMLElement, { table: HTMLTableElement; animation: Animation }>()

export function pinHeaders(root: ParentNode): void {
  if (!ViewTimeline) {
    return
  }

  if (!observer) {
    observer = new ResizeObserver((entries) => {
      const page = entries.some(({ target }) => target === document.documentElement)

      for (const table of page
        ? observed
        : entries.map(({ target }) => target as HTMLTableElement)) {
        measure(table)
      }
    })
    // Content growing above a table moves it off the pixel grid it was measured on, but keeps its size.
    observer.observe(document.documentElement)
  }

  for (const table of observed) {
    if (!table.isConnected) {
      observer.unobserve(table)
      observed.delete(table)
    }
  }

  for (const table of root.querySelectorAll("table")) {
    if (pinnable(table) && !observed.has(table)) {
      observed.add(table)
      observer.observe(table)
    }
  }
}

/** Move `element`, placed level with the top of `table`, down with the table's pinned header. */
export function follow(element: HTMLElement, table: HTMLTableElement): void {
  if (followers.get(element)?.table === table) {
    return
  }

  followers.get(element)?.animation.cancel()
  followers.delete(element)
  const pin = pinOf(table)

  if (pin) {
    followers.set(element, { table, animation: animate(element, pin.timeline) })
    measure(table)
  }
}

function measure(table: HTMLTableElement): void {
  const head = table.tHead
  const pin = pinOf(table)
  const bodies = [...table.tBodies]

  if (!head || !pin) {
    return
  }

  const { top, height } = table.getBoundingClientRect()

  if (height === 0 || bodies.length === 0) {
    for (const animation of [pin.header, pin.shade]) {
      setKeyframes(animation, [])
    }
    return
  }

  // Measured from the rows, which never move: the header's own box carries its pinning transform.
  const tall = head.getBoundingClientRect().height
  const start = bodies[0].getBoundingClientRect().top - top - tall
  const end = bodies[bodies.length - 1].getBoundingClientRect().bottom - top
  const span = Math.max(0, end - start - tall)
  // Pinned on the pixel grid the header rests on, so it draws as sharply: up to a pixel below the line.
  const shift = 1 - ((top + scrollY + start) % 1)
  const [from, to] = [(start + shift) / height, (start + shift + span) / height]
  const gap = gapOf(table)
  const lifted = `translateY(${span}px)`

  setKeyframes(pin.header, [
    { offset: from, transform: "none" },
    { offset: to, transform: lifted },
  ])
  // Lifted over the rows only while pinned: a positioned header draws its text differently at rest.
  setKeyframes(pin.shade, [
    { offset: from, "--pinned": "0", "--pin-content": '""', position: "static", zIndex: "auto" },
    {
      offset: Math.min(1, from + Math.max(1, gap) / height),
      "--pinned": "1",
      "--pin-content": '""',
      position: "relative",
      zIndex: "1",
    },
  ])

  for (const { animation } of [...followers.values()].filter((one) => one.table === table)) {
    setKeyframes(animation, [
      { offset: shift / height, transform: "none" },
      { offset: to, transform: `translateY(${start + span}px)` },
    ])
  }
}

function pinOf(table: HTMLTableElement): Pin | undefined {
  const head = table.tHead
  let pin = PINS.get(table)

  if (!pin && head && ViewTimeline && pinnable(table)) {
    const bar = document.querySelector<HTMLElement>(".bar")
    // The range starts a pixel past the line, where a header resting off the pixel grid pins.
    const timeline = new ViewTimeline({
      subject: table,
      axis: "block",
      inset: `${(bar?.offsetHeight ?? 0) + gapOf(table) + 1}px auto`,
    })
    pin = { timeline, header: animate(head, timeline), shade: animate(head, timeline) }
    PINS.set(table, pin)
    // The shade's layers move the header's box once it starts, a frame later; a cancelled one never does.
    pin.shade.ready.then(
      () => measure(table),
      () => undefined,
    )
  }

  return pin
}

/** A table inside another scrolls with the outer table's sideways box, which never scrolls down. */
function pinnable(table: HTMLTableElement): boolean {
  return Boolean(table.tHead?.rows.length) && !table.parentElement?.closest("table")
}

function gapOf(table: HTMLTableElement): number {
  return Number.parseFloat(getComputedStyle(table).getPropertyValue("--pin-gap")) || 0
}

function animate(element: HTMLElement, timeline: AnimationTimeline): Animation {
  return element.animate([], {
    timeline,
    fill: "both",
    easing: "linear",
    rangeStart: "exit-crossing 0%",
    rangeEnd: "exit-crossing 100%",
  } as KeyframeAnimationOptions)
}

/** Frames at 0 and 1 hold the ends: without them the browser eases from the element's own value. */
function setKeyframes(animation: Animation, frames: Keyframe[]): void {
  const first = frames[0]
  const last = frames.at(-1)
  const held = first && last ? [{ ...first, offset: 0 }, ...frames, { ...last, offset: 1 }] : []

  ;(animation.effect as KeyframeEffect).setKeyframes(held)
}
