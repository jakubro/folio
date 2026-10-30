/** Stylesheets the page script imports as text, which the build loads as strings. */

declare module "leaflet/dist/leaflet.css" {
  const text: string
  export default text
}
