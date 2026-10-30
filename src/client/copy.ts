/** Copy buttons: each puts its text on the clipboard and shows a check for a moment. */

import { button, ICONS } from "./icons.ts"

const COPIED_MS = 1500

export function copyButton(
  text: () => string,
  label: string,
  className: string,
): HTMLButtonElement {
  const copy = button(ICONS.copy, label, `icon-button ${className}`)
  let shown: ReturnType<typeof setTimeout> | undefined

  copy.addEventListener("click", async (event) => {
    event.preventDefault()
    event.stopPropagation()
    await navigator.clipboard.writeText(text())
    clearTimeout(shown)
    copy.innerHTML = ICONS.check
    copy.classList.add("copied")
    shown = setTimeout(() => {
      copy.innerHTML = ICONS.copy
      copy.classList.remove("copied")
    }, COPIED_MS)
  })

  return copy
}
