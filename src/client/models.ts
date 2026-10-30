/** ASCII STL fences drawn as 3D models the reader turns by dragging and zooms with buttons. */

import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { STLLoader } from "three/addons/loaders/STLLoader.js"
import { button, ICONS } from "./icons.ts"

const ZOOM_STEP = 0.8
const FIELD_OF_VIEW = 40
const DRAWN = new Set<{ host: HTMLElement; dispose: () => void }>()
const LEFT = new MutationObserver(() => release())

/** An ASCII STL model, drawn once on screen as WebGL contexts are few; throws why when it cannot be. */
export function modelOf(source: string, owner: Document): HTMLElement {
  let geometry: THREE.BufferGeometry

  release()

  try {
    geometry = new STLLoader().parse(source.slice(source.search(/\bsolid\b/)))
  } catch {
    throw new Error("the model has no facets")
  }

  if (!geometry.getAttribute("position")?.count) {
    throw new Error("the model has no facets")
  }

  const figure = owner.createElement("div")
  const canvas = figure.appendChild(owner.createElement("div"))
  const controls = figure.appendChild(owner.createElement("div"))
  const zoomIn = button(ICONS.zoomIn, "Zoom in")
  const zoomOut = button(ICONS.zoomOut, "Zoom out")
  const reset = button(ICONS.reset, "Reset view")
  const shown = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      shown.disconnect()
      const view = draw(canvas, geometry)
      zoomIn.addEventListener("click", () => view.zoom(ZOOM_STEP))
      zoomOut.addEventListener("click", () => view.zoom(1 / ZOOM_STEP))
      reset.addEventListener("click", () => view.reset())
    }
  })

  figure.className = "stl-model"
  canvas.className = "stl-canvas"
  controls.className = "stl-controls"
  controls.append(zoomIn, zoomOut, reset)
  shown.observe(canvas)
  return figure
}

function draw(
  host: HTMLElement,
  geometry: THREE.BufferGeometry,
): { zoom: (factor: number) => void; reset: () => void } {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  const material = new THREE.MeshStandardMaterial({
    color: 0xb8c0cc,
    metalness: 0.1,
    roughness: 0.7,
  })
  const resizing = new ResizeObserver(() => resize())
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.1, 1000)
  const light = new THREE.DirectionalLight(0xffffff, 1.5)
  const controls = new OrbitControls(camera, renderer.domElement)
  const styles = getComputedStyle(host)
  const render = () => renderer.render(scene, camera)
  const resize = () => {
    renderer.setSize(host.clientWidth, host.clientHeight)
    camera.aspect = host.clientWidth / host.clientHeight || 1
    camera.updateProjectionMatrix()
    render()
  }

  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  scene.background = new THREE.Color(styles.getPropertyValue("--subtle").trim() || "#f6f8fa")
  scene.add(new THREE.Mesh(geometry, material))
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2))
  light.position.set(1, 1, 2)
  camera.add(light)
  scene.add(camera)

  const sphere = geometry.boundingSphere as THREE.Sphere
  const distance = (sphere.radius || 1) / Math.sin(THREE.MathUtils.degToRad(FIELD_OF_VIEW / 2))
  camera.position
    .copy(sphere.center)
    .add(new THREE.Vector3(1, 1, 1).normalize().multiplyScalar(distance))
  camera.near = distance / 100
  camera.far = distance * 100
  controls.target.copy(sphere.center)
  controls.enableZoom = false
  controls.update()
  controls.saveState()
  controls.addEventListener("change", render)
  host.append(renderer.domElement)
  resizing.observe(host)
  resize()
  release()
  LEFT.observe(host.ownerDocument.body, { childList: true, subtree: true })
  DRAWN.add({
    host,
    dispose: () => {
      resizing.disconnect()
      controls.dispose()
      material.dispose()
      geometry.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
    },
  })

  return {
    zoom: (factor) => {
      camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target)
      controls.update()
    },
    reset: () => controls.reset(),
  }
}

function release(): void {
  for (const model of DRAWN) {
    if (!model.host.isConnected) {
      model.dispose()
      DRAWN.delete(model)
    }
  }

  if (DRAWN.size === 0) {
    LEFT.disconnect()
  }
}
