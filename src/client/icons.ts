// Inline SVG icons: 24x24, stroked in the current text colour.

const icon = (paths: string) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

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
};

export function button(icon: string, label: string, className = "icon-button"): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.title = label;
  element.setAttribute("aria-label", label);
  element.innerHTML = icon;
  return element;
}
