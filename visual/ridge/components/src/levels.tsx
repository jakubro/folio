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
