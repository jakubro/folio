/** Inline SVG icons: 24x24, stroked in the current text colour. */

const icon = (paths: string) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

export const ICONS = {
  expand: icon('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  close: icon('<path d="M18 6L6 18M6 6l12 12"/>'),
  zoomIn: icon('<path d="M12 5v14M5 12h14"/>'),
  zoomOut: icon('<path d="M5 12h14"/>'),
  fit: icon(
    '<path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3"/>',
  ),
  left: icon('<path d="M15 18l-6-6 6-6"/>'),
  up: icon('<path d="M18 15l-6-6-6 6"/>'),
  down: icon('<path d="M6 9l6 6 6-6"/>'),
  right: icon('<path d="M9 18l6-6-6-6"/>'),
  tree: icon('<path d="M3 7h18M3 12h18M3 17h18"/>'),
  outline: icon('<path d="M3 7h18M7 12h14M11 17h10"/>'),
  width: icon('<path d="M8 5L3 12l5 7M16 5l5 7-5 7M3 12h18"/>'),
  sun: icon(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  ),
  moon: icon('<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>'),
  live: icon(
    '<path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0118.8-4.3M22 12.5a10 10 0 01-18.8 4.2"/>',
  ),
  pause: icon('<path d="M10 4H6v16h4zM18 4h-4v16h4z"/>'),
  folder: icon('<path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
  file: icon(
    '<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/>',
  ),
  image: icon(
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
  ),
  diagram: icon(
    '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><path d="M6.5 10v4a2 2 0 002 2H14"/>',
  ),
  chevron: icon('<path d="M9 6l6 6-6 6"/>'),
  info: icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  alert: icon('<path d="M12 3L2 20h20zM12 10v4M12 17h.01"/>'),
  clock: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  inbox: icon(
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.5-6.9A2 2 0 0016.8 4H7.2a2 2 0 00-1.7 1.1z"/>',
  ),
  download: icon('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
  data: icon(
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
  ),
  filter: icon('<path d="M3 5h18l-7 8v6l-4 2v-8z"/>'),
  sort: icon('<path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4"/>'),
  copy: icon(
    '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
  ),
  check: icon('<path d="M20 6L9 17l-5-5"/>'),
  code: icon('<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>'),
  reset: icon('<path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.7L3 8"/><path d="M3 3v5h5"/>'),
  alert_note: icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  alert_tip: icon(
    '<path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.6 10.8c.8.6 1.1 1.3 1.1 2.2h5c0-.9.3-1.6 1.1-2.2A6 6 0 0012 3z"/>',
  ),
  alert_important: icon(
    '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><path d="M12 7v4M12 14h.01"/>',
  ),
  alert_warning: icon('<path d="M12 3L2 20h20zM12 10v4M12 17h.01"/>'),
  alert_caution: icon(
    '<path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z"/><path d="M12 8v4M12 16h.01"/>',
  ),
}

export function button(icon: string, label: string, className = "icon-button"): HTMLButtonElement {
  const element = document.createElement("button")
  element.type = "button"
  element.className = className
  element.title = label
  element.setAttribute("aria-label", label)
  element.innerHTML = icon
  return element
}
