#!/usr/bin/env node
// Renders the commit calendar shown in README.md as a standalone SVG.
//
// Data source: commits-daten.json on branch metrics, written by a count on the
// development machine. It counts every commit on the default branch of each
// swiss-cryptotax repository once, merge commits included, on the day of its
// author date in Europe/Zurich. The file carries nothing but days and counts:
//
//   [{"date":"YYYY-MM-DD","count":N}, ...]
//
// Any other form is refused, so a repository name, a commit text or an address
// can never reach the card. The renderer reads no API and needs no token.
//
// The window ends on the current day in CAL_TZ. A day the file does not name
// is drawn as a day without commits.
//
// Environment:
//   CAL_DATA      path of commits-daten.json                  (required)
//   CAL_OUT_LIGHT output path of the light SVG              (required)
//   CAL_OUT_DARK  output path of the dark SVG               (required)
//   CAL_DAYS      length of the window in days, default 183
//   CAL_TZ        time zone that defines "today", default Europe/Zurich
//
// Exit codes: 0 written, 1 refused. Every refusal names what was missing.

import {writeFileSync, readFileSync} from "node:fs"

const env = (name, fallback = null) => {
  const value = process.env[name]
  if (value === undefined || value === "") {
    if (fallback === null) {
      console.error(`::error::${name} is not set.`)
      process.exit(1)
    }
    return fallback
  }
  return value
}

const datei = env("CAL_DATA")
const ausgaben = {light: env("CAL_OUT_LIGHT"), dark: env("CAL_OUT_DARK")}
const days = Number(env("CAL_DAYS", "183"))
const zone = env("CAL_TZ", "Europe/Zurich")

if (!Number.isInteger(days) || days < 7 || days > 366) {
  console.error(`::error::CAL_DAYS must be an integer between 7 and 366, got "${days}".`)
  process.exit(1)
}

// ---------------------------------------------------------------- date window

// Today in CAL_TZ, as a plain calendar date. Commits of the current day
// belong to the render; a window that stops yesterday looks identical on every
// re-run of the same day, and a re-run then writes nothing.
const heute = new Intl.DateTimeFormat("en-CA", {timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date())
const tagAus = iso => new Date(`${iso}T00:00:00Z`)
const isoAus = date => date.toISOString().slice(0, 10)
const plusTage = (date, n) => new Date(date.getTime() + n * 86400000)

const ende = tagAus(heute)
let start = plusTage(ende, -(days - 1))
start = plusTage(start, -start.getUTCDay()) // first column begins on a Sunday

const spalten = Math.ceil((Math.round((ende - start) / 86400000) + 1) / 7)

// ---------------------------------------------------------------------- daten

const weg = text => {
  console.error(`::error::${datei}: ${text}`)
  process.exit(1)
}

// "2026-02-30" parses as 2 March; a real day reads back as itself.
const kalendertag = text => {
  const zeit = new Date(`${text}T00:00:00Z`).getTime()
  return !Number.isNaN(zeit) && new Date(zeit).toISOString().slice(0, 10) === text
}

// The only accepted form. Every entry is an object with exactly the keys date
// and count, the date is a real calendar day, the count a whole number from 0,
// and the dates rise strictly, so no day appears twice.
function liesDaten() {
  let text, roh
  try {
    text = readFileSync(datei, "utf8")
    roh = JSON.parse(text)
  } catch (fehler) {
    weg(`cannot be read as JSON: ${fehler.message}`)
  }
  if (!Array.isArray(roh))
    weg(`must be a JSON array, found ${roh === null ? "null" : typeof roh}.`)
  if (!roh.length)
    weg("holds no days.")
  let vorher = ""
  roh.forEach((eintrag, i) => {
    const stelle = `entry ${i + 1}`
    if (eintrag === null || typeof eintrag !== "object" || Array.isArray(eintrag))
      weg(`${stelle} is not an object.`)
    const schluessel = Object.keys(eintrag).sort()
    if (schluessel.length !== 2 || schluessel[0] !== "count" || schluessel[1] !== "date")
      weg(`${stelle} carries the keys [${schluessel.join(", ")}], allowed are exactly count and date.`)
    const {date, count} = eintrag
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !kalendertag(date))
      weg(`${stelle} has no calendar date in the form YYYY-MM-DD: ${JSON.stringify(date)}.`)
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      weg(`${stelle} has no whole count from 0: ${JSON.stringify(count)}.`)
    if (date <= vorher)
      weg(`${stelle} (${date}) does not follow ${vorher}: the dates must rise, each day once.`)
    vorher = date
  })
  // A key written twice survives JSON.parse, the last one wins, and the first
  // would carry any text past the checks above. So the file has to be, up to
  // whitespace, exactly the array it parses to, keys in the order date, count.
  const kanonisch = JSON.stringify(roh.map(({date, count}) => ({date, count})))
  if (text.replace(/\s+/g, "") !== kanonisch)
    weg(`is not, up to whitespace, the plain form [{"date":"YYYY-MM-DD","count":N}, ...]: a key is written twice, the keys stand in another order, or a number is written in another notation.`)
  return roh
}

const gemeldet = liesDaten()
const zaehler = new Map(gemeldet.map(tag => [tag.date, tag.count]))

// The grid is built from the window, not from the file: a day the file leaves
// out stays an empty cell instead of shifting every later column by one.
const tage = []
for (let i = 0; ; i++) {
  const tag = plusTage(start, i)
  if (tag > ende)
    break
  const iso = isoAus(tag)
  tage.push({iso, tag, count: zaehler.get(iso) ?? 0})
}
if (tage.length !== spalten * 7 - (6 - ende.getUTCDay())) {
  console.error(`::error::Grid does not match the window: ${tage.length} days over ${spalten} weeks.`)
  process.exit(1)
}

const gesamt = tage.reduce((summe, tag) => summe + tag.count, 0)
const aktiv = tage.filter(tag => tag.count > 0).length
const hoechst = tage.reduce((max, tag) => Math.max(max, tag.count), 0)

let laengste = 0, aktuelle = 0
for (const tag of tage) {
  aktuelle = tag.count > 0 ? aktuelle + 1 : 0
  laengste = Math.max(laengste, aktuelle)
}
// The current streak ignores a still empty today: it is not a broken streak yet.
let strecke = 0
for (let i = tage.length - 1; i >= 0; i--) {
  if (tage[i].count === 0) {
    if (i === tage.length - 1)
      continue
    break
  }
  strecke++
}

// Four levels over the observed maximum. An empty window keeps every cell at 0.
const stufe = count => {
  if (count <= 0)
    return 0
  if (hoechst <= 0)
    return 0
  const anteil = count / hoechst
  return anteil <= 0.25 ? 1 : anteil <= 0.5 ? 2 : anteil <= 0.75 ? 3 : 4
}

// ------------------------------------------------------------------- zeichnen
//
// Isometric projection, 2:1. Every day is a block: a rhombic lid and, as soon
// as the day carries commits, two side faces. The lid of cell (c, r) —
// week c, weekday r — sits at
//
//   x = X0 + (c - r) * a          a = half width of the rhombus
//   y = Y0 + (c + r) * b - h      b = a / 2, h = height of the block
//
// so a week runs down to the right and a weekday down to the left. Blocks are
// emitted from the back (small c + r) to the front: a block drawn later paints
// over the one behind it, which is what gives the grid its depth. Emitted in
// the other order, the back row would cover the front row.
//
// The card keeps a fixed width; the cell size follows from the number of weeks
// in the window, so a longer window yields finer blocks instead of a wider
// image that no README can show.

const BREITE = 880
const RAND_LINKS = 52, RAND_RECHTS = 46
const OBEN = 62

const n2 = wert => {
  const gerundet = Math.round(wert * 100) / 100
  return String(gerundet)
}

const a = Math.round(((BREITE - RAND_LINKS - RAND_RECHTS) / (spalten + 7)) * 100) / 100
const b = a / 2
const H_MAX = a * 1.8                      // höchste Säule
const SOCKEL = a * 0.2                     // jeder Tag mit Beiträgen ist sichtbar erhoben
const FUGE = 0.93                          // Fuge zwischen den Bloecken: ein leerer Tag bleibt ein Tag
const ZA = a * FUGE, ZB = b * FUGE
const X0 = RAND_LINKS + 7 * a              // linkester Punkt des Gitters liegt auf RAND_LINKS
const Y0 = OBEN + H_MAX + b                // oberster Punkt der höchsten Säule liegt auf OBEN
const BODEN = Y0 + (spalten + 6) * b       // tiefster Punkt des Gitters
const legendeY = Math.round(BODEN + 30)
const HOEHE = Math.round(legendeY + 44)

// Height over the observed maximum, slightly compressed so a single busy day
// does not flatten every other block into the floor.
const saeule = count => count <= 0 || hoechst <= 0 ? 0 : SOCKEL + (H_MAX - SOCKEL) * Math.pow(count / hoechst, 0.7)

// Lid, left face, right face of one block. The drawn rhombus is a little
// smaller than the step of the grid, so two neighbouring days keep a seam: a
// week without commits has to stay readable as seven days, not as one
// slab. A block of height 0 is a floor tile and has no side faces: two faces of
// zero area would still cost bytes and would make "this day has commits"
// unreadable from the geometry.
const block = (x, y, halb, halbH, h, s) => {
  const deckel = `<path class="o${s}" d="M${n2(x)},${n2(y - halbH - h)} ${n2(x + halb)},${n2(y - h)} ${n2(x)},${n2(y + halbH - h)} ${n2(x - halb)},${n2(y - h)}Z"`
  if (h <= 0)
    return {seiten: "", deckel}
  const links = `<path class="l${s}" d="M${n2(x - halb)},${n2(y - h)} ${n2(x)},${n2(y + halbH - h)} ${n2(x)},${n2(y + halbH)} ${n2(x - halb)},${n2(y)}Z"/>`
  const rechts = `<path class="r${s}" d="M${n2(x)},${n2(y + halbH - h)} ${n2(x + halb)},${n2(y - h)} ${n2(x + halb)},${n2(y)} ${n2(x)},${n2(y + halbH)}Z"/>`
  return {seiten: `${links}${rechts}`, deckel}
}

const monate = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const esc = text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const zahl = n => n.toLocaleString("en-US")
const langDatum = iso => `${Number(iso.slice(8, 10))} ${monate[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`

// Blocks by depth: c + r ascending. Days of equal depth do not overlap, so
// their order among themselves does not matter.
const nachTiefe = tage
  .map((tag, index) => ({tag, c: Math.floor(index / 7), r: index % 7}))
  .sort((links, rechts) => (links.c + links.r) - (rechts.c + rechts.r))

let bloecke = ""
for (const {tag, c, r} of nachTiefe) {
  const s = stufe(tag.count)
  const {seiten, deckel} = block(X0 + (c - r) * a, Y0 + (c + r) * b, ZA, ZB, saeule(tag.count), s)
  const titel = `${tag.count === 0 ? "No commits" : `${zahl(tag.count)} commit${tag.count === 1 ? "" : "s"}`} on ${langDatum(tag.iso)}`
  bloecke += `\n    ${seiten}${deckel}><title>${esc(titel)}</title></path>`
}

// Month label above the upper right edge of the parallelogram, on the week
// axis the labels belong to. In this projection a block covers a strip of the
// image, not a point: every cell with c - r in {c, c+1, c+2} lies under the
// label's few characters, however far down the grid it sits, because height
// lifts it back up. The label goes above the highest lid of that strip, so a
// busy day never paints over the month it belongs to.
const etiketteY = c => {
  let oben = Y0 + c * b - b
  for (const {tag, c: spalte, r} of nachTiefe) {
    const d = spalte - r
    if (d < c || d > c + 2)
      continue
    oben = Math.min(oben, Y0 + (spalte + r) * b - saeule(tag.count) - b)
  }
  return oben - 6
}

const beschriftungen = []
let letzterMonat = -1, letzteSpalte = -Infinity
for (let c = 0; c < spalten; c++) {
  const erster = tage[c * 7]
  if (!erster)
    continue
  const monat = erster.tag.getUTCMonth()
  if (monat === letzterMonat || c - letzteSpalte < 2)
    continue
  beschriftungen.push({x: X0 + c * a + 12, y: etiketteY(c), text: monate[monat]})
  letzterMonat = monat
  letzteSpalte = c
}

// Legend as five blocks of growing height: the card explains its own third
// dimension instead of leaving the reader to guess what the height means.
const LEG_A = 11, LEG_B = LEG_A / 2, LEG_H = 26, LEG_SCHRITT = 2.6 * LEG_A
const legendeBreite = 4 * LEG_SCHRITT + 2 * LEG_A
const mehrX = BREITE - RAND_RECHTS - 30
const legendeX = mehrX - 8 - legendeBreite + LEG_A
let legende = ""
for (let s = 0; s <= 4; s++) {
  const h = s === 0 ? 0 : LEG_H * Math.pow(s / 4, 0.7)
  const {seiten, deckel} = block(legendeX + s * LEG_SCHRITT, legendeY, LEG_A, LEG_B, h, s)
  legende += `\n    ${seiten}${deckel}/>`
}

const kopf = `${zahl(gesamt)} commit${gesamt === 1 ? "" : "s"} in the last ${Math.round(days / 30.5)} months`
const fuss = `${langDatum(isoAus(start))} – ${langDatum(heute)}  ·  ${aktiv} active day${aktiv === 1 ? "" : "s"}  ·  longest streak ${laengste}  ·  current streak ${strecke}`

// Two files instead of one file with a media query: README.md picks the theme
// through <picture>, the same way the process graphic does. Each file then
// shows its own palette when it is opened on its own as well.
//
// The side faces are frozen colours, not opacity and not an SVG filter: the
// card is served as an <img>, and a filter per face costs the reader's
// renderer three passes over every block for a shade that never changes.
const paletten = {
  light: {
    kopf: "#1C2143", klein: "#6B6F80", fuss: "#8A8E9C",
    stufen: ["#E9E6E0", "#BFC2D2", "#8E93AE", "#4E5686", "#1C2143"],
    seite: [0.84, 0.64],
  },
  dark: {
    kopf: "#E6E9F2", klein: "#9AA0B4", fuss: "#7F8598",
    stufen: ["#1F2340", "#33395F", "#4E5786", "#8A93B8", "#CFBDA2"],
    seite: [0.78, 0.56],
  },
}

// #RRGGBB scaled towards black. The lid keeps the palette value, the right
// face is the lit side, the left face the shaded one.
const tonen = (hex, faktor) => "#" + [1, 3, 5]
  .map(i => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * faktor))).toString(16).padStart(2, "0"))
  .join("")

const zeichne = palette => `<svg xmlns="http://www.w3.org/2000/svg" width="${BREITE}" height="${HOEHE}" viewBox="0 0 ${BREITE} ${HOEHE}" role="img" aria-label="${esc(kopf)}">
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .kopf { font-size: 17px; font-weight: 600; fill: ${palette.kopf}; }
    .klein { font-size: 11px; fill: ${palette.klein}; }
    .fuss  { font-size: 11px; fill: ${palette.fuss}; }
    ${palette.stufen.map((farbe, s) => `.o${s} { fill: ${farbe}; } .r${s} { fill: ${tonen(farbe, palette.seite[0])}; } .l${s} { fill: ${tonen(farbe, palette.seite[1])}; }`).join("\n    ")}
  </style>
  <text class="kopf" x="${RAND_LINKS}" y="26">${esc(kopf)}</text>${bloecke}
  ${beschriftungen.map(({x, y, text}) => `<text class="klein" x="${n2(x)}" y="${n2(y)}">${text}</text>`).join("\n  ")}
  <text class="klein" text-anchor="end" x="${n2(legendeX - LEG_A - 8)}" y="${legendeY + 4}">Less</text>${legende}
  <text class="klein" x="${mehrX}" y="${legendeY + 4}">More</text>
  <text class="fuss" x="${RAND_LINKS}" y="${HOEHE - 14}">${esc(fuss)}</text>
</svg>
`

const geschrieben = {}
for (const [name, pfad] of Object.entries(ausgaben)) {
  const svg = zeichne(paletten[name])
  writeFileSync(pfad, svg)
  geschrieben[pfad] = {bytes: Buffer.byteLength(svg), zeilen: svg.split("\n").length - 1}
}

// The report is the proof that the step acted. It names the files, their size,
// the window and the totals, so a run that writes the same bytes twice is
// readable as "no new commits" instead of "nothing happened".
const bericht = {
  dateien: geschrieben,
  quelle: datei,
  fenster: `${isoAus(start)}..${heute}`,
  tage: tage.length,
  wochen: spalten,
  commits: gesamt,
  aktive_tage: aktiv,
  hoechster_tag: hoechst,
  laengste_strecke: laengste,
  aktuelle_strecke: strecke,
  zeitpunkt: new Date().toISOString(),
}
console.log(`geschrieben ${JSON.stringify(bericht)}`)
if (gesamt === 0)
  console.log(`::warning::${datei} names no commits in ${isoAus(start)}..${heute}. The calendar is empty.`)

if (process.env.GITHUB_OUTPUT) {
  const bytes = Object.values(geschrieben).map(eintrag => eintrag.bytes).join(" / ")
  writeFileSync(process.env.GITHUB_OUTPUT, `commits=${gesamt}\nfenster=${isoAus(start)}..${heute}\nbytes=${bytes}\n`, {flag: "a"})
}
