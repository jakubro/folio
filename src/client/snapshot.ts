/** A frozen page's script: its tables sort, filter, narrow and fold, from the views it was frozen with. */

import { TableViews } from "./tableviews.ts"

const main = document.querySelector("main") as HTMLElement
const article = main.querySelector("article") as HTMLElement
const views = JSON.parse(document.getElementById("folio-views")?.textContent ?? "{}")

new TableViews(main).restore(article, "", views)
