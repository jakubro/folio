/** GeoJSON and TopoJSON fences drawn as maps: shapes offline, OpenStreetMap tiles only once asked for. */

import * as L from "leaflet"
import leafletStyles from "leaflet/dist/leaflet.css"

type Topology = Parameters<typeof import("topojson-client")["feature"]>[0]
type FeatureCollection = GeoJSON.FeatureCollection

const TYPES = new Set([
  "FeatureCollection",
  "Feature",
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
])
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const POINT_ZOOM = 10
const POINT_FILL = 0.8
const PADDING: [number, number] = [16, 16]

const TILED = new Set<string>()
let styled = false

/** Drawn once on screen: Leaflet sizes its view from a container laid out on the page. Rejects with why. */
export async function mapOf(
  source: string,
  format: "geojson" | "topojson",
  owner: Document,
): Promise<HTMLElement> {
  const geo = format === "topojson" ? await topology(json(source)) : shapes(json(source))
  let layer: L.GeoJSON

  try {
    layer = L.geoJSON(geo, {
      pointToLayer: (_, at) => L.circleMarker(at, { radius: 5, fillOpacity: POINT_FILL }),
      onEachFeature: (feature, shape) => {
        if (feature.properties && Object.keys(feature.properties).length > 0) {
          shape.bindPopup(() => popup(owner, feature.properties))
        }
      },
    })
  } catch {
    throw new Error("its geometry is not valid")
  }

  style()
  const figure = owner.createElement("div")
  const canvas = figure.appendChild(owner.createElement("div"))
  const tiles = figure.appendChild(owner.createElement("button"))
  const shown = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      shown.disconnect()
      draw(canvas, layer, source, tiles)
    }
  })

  figure.className = "geo-map"
  canvas.className = "geo-map-canvas"
  tiles.className = "geo-map-tiles"
  tiles.type = "button"
  tiles.textContent = "Load map"
  tiles.hidden = TILED.has(source)
  shown.observe(canvas)
  return figure
}

function draw(canvas: HTMLElement, layer: L.GeoJSON, source: string, tiles: HTMLElement): void {
  const map = L.map(canvas, { scrollWheelZoom: false, minZoom: 1, maxZoom: 19 })
  const accent = getComputedStyle(canvas).getPropertyValue("--accent").trim()
  const bounds = layer.getBounds()
  const load = () => {
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map)
    tiles.hidden = true
  }

  map.attributionControl.setPrefix(false)
  layer.setStyle({ color: accent, weight: 2, fillOpacity: 0.2 }).addTo(map)

  if (!bounds.isValid()) {
    map.setView([0, 0], 1)
  } else if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
    map.setView(bounds.getCenter(), POINT_ZOOM)
  } else {
    map.fitBounds(bounds, { padding: PADDING })
  }

  // A point inside an area is drawn under it, where no click would reach its popup.
  for (const point of pointsIn(layer)) {
    point.setStyle({ fillOpacity: POINT_FILL }).bringToFront()
  }

  if (TILED.has(source)) {
    load()
  }

  tiles.addEventListener("click", () => {
    TILED.add(source)
    load()
  })
}

function json(source: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    throw new Error("it is not valid JSON")
  }
}

function shapes(value: unknown): GeoJSON.GeoJsonObject {
  if (!TYPES.has((value as { type?: unknown } | null)?.type as string)) {
    throw new Error("it is not GeoJSON")
  }

  return value as GeoJSON.GeoJsonObject
}

async function topology(value: unknown): Promise<FeatureCollection> {
  const data = value as Topology | null
  const objects = data?.type === "Topology" ? Object.values(data.objects ?? {}) : []

  if (objects.length === 0) {
    throw new Error("it is not a TopoJSON topology with objects")
  }

  const { feature } = await import("topojson-client")
  const features = objects.flatMap((object) => {
    let converted: GeoJSON.Feature | FeatureCollection

    try {
      converted = feature(data as Topology, object) as GeoJSON.Feature | FeatureCollection
    } catch {
      throw new Error("its geometry is not valid")
    }

    return converted.type === "FeatureCollection" ? converted.features : [converted]
  })

  return { type: "FeatureCollection", features }
}

/** Plain text: a feature's properties are the document's own text, never markup. */
function popup(owner: Document, properties: Record<string, unknown>): HTMLElement {
  const body = owner.createElement("div")

  for (const [key, value] of Object.entries(properties)) {
    body.appendChild(owner.createElement("div")).textContent =
      `${key}: ${value !== null && typeof value === "object" ? JSON.stringify(value) : String(value)}`
  }

  return body
}

/** Leaflet's own pictures are left out of its stylesheet, so a map asks the network for nothing. */
function style(): void {
  if (styled) {
    return
  }

  styled = true
  document.head.appendChild(document.createElement("style")).textContent = leafletStyles.replace(
    /url\(images\/[^)]*\)/g,
    "none",
  )
}

function pointsIn(shape: L.Layer): L.CircleMarker[] {
  if (shape instanceof L.CircleMarker) {
    return [shape]
  }

  return shape instanceof L.LayerGroup ? shape.getLayers().flatMap(pointsIn) : []
}
