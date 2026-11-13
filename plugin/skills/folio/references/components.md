# Writing a Folio component

A component draws a ` ```component <name> ` fence with a script of the folder's own: `<name>.js` at the top of a components folder the user names when starting Folio, `folio FOLDER --components PATH`. The script gets the rows the fence names and redraws them each time the data changes. Write one where a document should show its data in a way no table, value or Vega-Lite chart can - a calendar, a timeline, a form - and keep the data in the folder's files, where every other embed reads it too.

````markdown
```component levels
data:
  readings: data/daily.csv
title: Rain by station
```
````

`data` maps each entry to a reference, written as `{table: ...}` writes one; every other key is an option handed to the script as written.

## The contract

The script is an ES module whose default export Folio calls with an element to draw into and a context, once the page holding the fence is shown. It may return `update`, called with the new context when a file an entry reads changes, and `destroy`, called before the drawing goes; either may be left out, and a component without `update` is drawn again from scratch. It may instead return a text of markdown, which Folio draws as the whole component - see *Markdown Folio draws*.

| Context | Holds |
|---|---|
| `data` | Each entry by its name: a table's or a query's rows as records, a JSON or YAML file's or a part's value as written |
| `options` | Every key of the fence but `data`, as YAML reads it |
| `theme` | `light` or `dark` |
| `act(action, details)` | Sends an action off the page and answers with a promise - see *Actions* |
| `markdown(text)` | Draws markdown as the page draws it and answers with a promise of an element to place - see *Markdown Folio draws* |

A minimal component, in plain JavaScript, needing no build - `wettest.js` in the components folder:

```js
export default function wettest(element, { data, options }) {
  const title = Object.assign(document.createElement("h3"), { textContent: options.title })
  const list = document.createElement("ol")
  const show = (readings) => {
    const totals = new Map()

    for (const { station, rain_mm } of readings) {
      totals.set(station, (totals.get(station) ?? 0) + rain_mm)
    }

    list.replaceChildren(
      ...[...totals]
        .sort(([, a], [, b]) => b - a)
        .map(([station, mm]) =>
          Object.assign(document.createElement("li"), { textContent: `${station}: ${mm.toFixed(1)} mm` }),
        ),
    )
  }

  show(data.readings)
  element.append(title, list)

  return { update: ({ data }) => show(data.readings) }
}
```

## Styling

The element sits in a shadow root of the component's own. Folio's stylesheet does not reach it, so style every table, list and heading the component draws, with a `<style>` element of its own inside the element. Folio's colours reach it as CSS variables in either theme - `--bg`, `--fg`, `--muted`, `--faint`, `--border`, `--subtle`, `--hover` and `--accent` - with its faces `--sans` and `--mono` and the page's text font and colour; draw with them, and the component matches the page in both themes. A theme switch draws the component again.

## Live updates

`update` gets the whole new context as soon as an embed beside the fence would redraw. Keep the component's own state - what is open, what is typed, where it scrolls - across it, and replace only what shows the data. Saving the script draws every component of its name on every open page again with the new code, `destroy` first; editing the fence draws it again too.

## Actions

The page writes nothing, and neither does Folio: `act(action, details)` sends what the reader asked for off the page, as a `folio:action` event that a browser extension's content script or a script pasted into the console carries out. Call it from the reader's click, so the handler holds that click; give it plain data, which is all that crosses into another script world. It resolves once the handler answers done, and rejects with the handler's reason, or at once with *Nothing on this page carries out \<action>.* when nothing on the page takes it. Show the outcome in the component. The Components reference's *Actions* entry has a handler script for `levels`'s `flag`: [Components](https://jakubro.github.io/folio/reference/components/).

## Markdown Folio draws

Hand Folio markdown rather than bundling a renderer: Folio draws it exactly as the page draws the same markdown, in the page's styles and theme - a mermaid diagram, a table that sorts and filters, highlighted code, math, a Vega-Lite chart with its values inline, a map, a 3D model. A component whose whole drawing is markdown returns the text, and gets drawn again when its data changes:

```js
export default function readings(element, { data }) {
  return ["| Day | Station | Rain |", "|---|---|---|", ...data.readings.map((row) => `| ${row.date} | ${row.station} | ${row.rain_mm} |`)].join("\n")
}
```

A component that draws markdown among its own elements calls `markdown(text)` and places the element it answers with. A click on the drawing reaches the component's own listeners with the element clicked - a diagram's box, by its id - since mermaid draws no links of its own on a Folio page:

```js
export default async function network(element, { data, markdown }) {
  const toggle = Object.assign(document.createElement("button"), { textContent: "Show the links" })
  const holder = document.createElement("div")
  const draw = async ({ data }) => {
    const links = data.links.map((link) => `  ${link.from} --> ${link.to}`)
    const diagram = await markdown(["```mermaid", "flowchart LR", ...links, "```"].join("\n"))

    diagram.addEventListener("click", (event) => {
      const box = event.target.closest(".node")
      if (box) {
        toggle.textContent = `Picked ${box.id}`
      }
    })
    holder.replaceChildren(diagram)
  }

  toggle.addEventListener("click", () => {
    holder.hidden = !holder.hidden
  })
  element.append(toggle, holder)
  await draw({ data })

  return { update: draw }
}
```

- **New markdown** answers a new element; replace the old one with it. A drawing goes once its element, placed, leaves the component, so hide an element - `hidden` - to show it again later.
- **Only what the page draws from a block's own text.** An include, a `{table: ...}` or `{value: ...}` reference, a figure, a query, a component fence and a chart reading a file read nothing: each shows *Markdown from a component takes no includes, data references or queries.* Put the data in the markdown itself - a chart's `values`, a table's rows - from the component's own entries.
- A fence that does not draw - a diagram that does not parse - shows its source and reason as on a page, and Folio's drawing has no block ids.

## TypeScript and React

Folio serves only the `.js` at the top of the components folder, and a page loads nothing else: build each component into one file that imports nothing, with the folder's own build.

```text
components/
  levels.js        the built component Folio serves
  package.json
  tsconfig.json
  src/levels.tsx
```

`package.json` holds the build - `tsc` checks the types, and esbuild bundles React into the one file:

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc && esbuild src/levels.tsx --bundle --format=esm --minify --outfile=levels.js"
  },
  "devDependencies": {
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "esbuild": "0.28.2",
    "react": "19.3.1",
    "react-dom": "19.3.1",
    "typescript": "7.0.2"
  },
  "allowScripts": {
    "esbuild": false
  }
}
```

`tsconfig.json` names the JSX runtime, which esbuild reads too:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
```

The default export makes a React root in the element, renders into it again on each `update`, and unmounts it on `destroy`, so React keeps the component's state across new data. This is `levels`, which draws a rain gauge per station filled to its total, opens a station's days on a click and flags a day through `act`:

```tsx
/** Folio component: a rain gauge per station filled to its total rain, whose days open to be flagged. */

import { useState } from "react"
import { createRoot } from "react-dom/client"

interface Reading {
  date: string
  station: string
  rain_mm: number
}

interface Context {
  data: { readings: Reading[] }
  options: { title?: string }
  act: (action: string, details: unknown) => Promise<void>
}

interface Station {
  name: string
  total: number
  days: Reading[]
}

const CAPACITY_MM = 100
const STYLE = `
.levels { font-family: var(--sans); color: var(--fg); }
h3 { margin: 0 0 12px; font-size: 1.1em; }
.gauges { display: flex; gap: 16px; align-items: flex-end; }
.gauge {
  display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 12px;
  border: 1px solid transparent; border-radius: 6px; background: none; color: inherit; font: inherit;
  cursor: pointer;
}
.gauge:hover { background: var(--hover); }
.gauge[aria-expanded="true"] { border-color: var(--border); background: var(--subtle); }
.tube {
  position: relative; width: 28px; height: 100px; overflow: hidden;
  border: 1px solid var(--border); border-top: none; border-radius: 0 0 6px 6px;
}
.fill { position: absolute; inset: auto 0 0; background: var(--accent); }
.name { text-transform: capitalize; }
.total, .said { color: var(--muted); }
.days { margin-top: 12px; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.days caption { padding-bottom: 6px; font-weight: 600; text-align: left; text-transform: capitalize; }
.days td { padding: 1px 16px 1px 0; border-bottom: 1px solid var(--border); }
.days .rain { text-align: right; }
.days button {
  padding: 0 8px; border: 1px solid var(--border); border-radius: 4px; background: none;
  color: var(--accent); font: inherit; cursor: pointer;
}
`

export default function levels(element: HTMLElement, context: Context) {
  const root = createRoot(element)
  const draw = ({ data, options, act }: Context) =>
    root.render(<Levels readings={data.readings} title={options.title} act={act} />)

  draw(context)

  return { update: draw, destroy: () => root.unmount() }
}

function Levels({
  readings,
  title,
  act,
}: {
  readings: Reading[]
  title?: string
  act: Context["act"]
}) {
  const [open, setOpen] = useState<string>()
  const [said, setSaid] = useState<Record<string, string>>({})
  const stations = byStation(readings)
  const shown = stations.find(({ name }) => name === open)

  const flag = (station: string, { date, rain_mm }: Reading) => {
    const key = `${station} ${date}`
    const say = (text: string) => setSaid((was) => ({ ...was, [key]: text }))

    say("Flagging")
    act("flag", { station, day: { date, rain_mm } }).then(
      () => say("Flagged"),
      (error: Error) => say(error.message),
    )
  }

  return (
    <div className="levels">
      <style>{STYLE}</style>
      {title && <h3>{title}</h3>}
      <div className="gauges">
        {stations.map(({ name, total }) => (
          <button
            key={name}
            type="button"
            className="gauge"
            aria-expanded={name === open}
            onClick={() => setOpen(name === open ? undefined : name)}
          >
            <span className="tube">
              <span
                className="fill"
                style={{ height: `${(100 * Math.min(total, CAPACITY_MM)) / CAPACITY_MM}%` }}
              />
            </span>
            <span className="name">{name}</span>
            <span className="total">{total.toFixed(1)} mm</span>
          </button>
        ))}
      </div>
      {shown && (
        <table className="days">
          <caption>{shown.name}</caption>
          <tbody>
            {shown.days.map((day) => (
              <tr key={day.date}>
                <td>{day.date}</td>
                <td className="rain">{day.rain_mm.toFixed(1)} mm</td>
                <td>
                  <button type="button" onClick={() => flag(shown.name, day)}>
                    Flag
                  </button>
                </td>
                <td className="said">{said[`${shown.name} ${day.date}`]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function byStation(readings: Reading[]): Station[] {
  const stations = new Map<string, Station>()

  for (const reading of readings) {
    const station = stations.get(reading.station) ?? { name: reading.station, total: 0, days: [] }

    station.total += reading.rain_mm
    station.days.push(reading)
    stations.set(reading.station, station)
  }

  return [...stations.values()]
}
```

Run `npm run build` after every change to the source, and commit the built file beside it.

## The page's limits

- **One file.** A script importing anything - a package, another file of the folder - fails to load: every import is bundled into the one file.
- **No generated code.** The page's policy forbids `eval` and `new Function`; a library that compiles templates or expressions at run time needs a build that does not.
- **Folio's origin only.** Scripts, stylesheets, fonts and requests from another origin are refused; images load from anywhere.
- **Shown pages only.** A component draws once its page is shown, never for a page prepared while the pointer rests on a link to it.
- **Its own keys.** A key pressed inside the component is the component's own; the page's arrow keys stay out of its fields.
- **Frozen pages.** A downloaded page keeps the drawing as last shown, without its script or handlers.

## Check a component

- `curl -s 'http://localhost:8640/?components'` lists the components folders and each component by the script it draws from; a name missing there is a script Folio does not see.
- `?api=health` on the document - `folio_health` given its path - lists a fence that cannot be read, a name no components folder holds and each `data` entry that reads nothing. Without a running Folio, `folio check ROOT --components PATH` checks the same.
- `?api=embed&reference=<reference>` on the document, for the reference an entry names - `folio_embed` - shows what that entry hands the script.
- A script's own errors - one that fails to load, has no default export or throws while it draws - show only on the page: the fence's YAML, marked red, with the reason below it. Open the page, or ask the user to, before calling the component done.
