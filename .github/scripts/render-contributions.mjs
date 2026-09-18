#!/usr/bin/env node
// Renders the contribution calendar shown in README.md as a standalone SVG.
//
// Data source: GitHub GraphQL contributionsCollection. The window ends on the
// current day in CAL_TZ, so contributions made today are part of the render.
//
// Environment:
//   CAL_LOGIN     GitHub login to render                    (required)
//   CAL_TOKEN     token for the GraphQL query               (required unless CAL_FIXTURE)
//   CAL_OUT_LIGHT output path of the light SVG              (required)
//   CAL_OUT_DARK  output path of the dark SVG               (required)
//   CAL_DAYS      length of the window in days, default 183
//   CAL_TZ        time zone that defines "today", default Europe/Zurich
//   CAL_FIXTURE   local JSON file [{date,count}, ...] instead of the API (for checks)
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

const login = env("CAL_LOGIN")
const ausgaben = {light: env("CAL_OUT_LIGHT"), dark: env("CAL_OUT_DARK")}
const days = Number(env("CAL_DAYS", "183"))
const zone = env("CAL_TZ", "Europe/Zurich")
const fixture = process.env.CAL_FIXTURE || ""

if (!Number.isInteger(days) || days < 7 || days > 366) {
  console.error(`::error::CAL_DAYS must be an integer between 7 and 366, got "${days}".`)
  process.exit(1)
}

// ---------------------------------------------------------------- date window

// Today in CAL_TZ, as a plain calendar date. Contributions of the current day
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

async function ausApi() {
  const token = env("CAL_TOKEN")
  const abfrage = `query($login: String!, $von: DateTime!, $bis: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $von, to: $bis) {
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }`
  // The end of the day in CAL_TZ can still lie ahead in UTC; the query never
  // asks for a point in the future.
  const tagesende = new Date(`${heute}T23:59:59Z`)
  const jetzt = new Date()
  const bis = (tagesende > jetzt ? jetzt : tagesende).toISOString().replace(/[.]\d+Z$/, "Z")
  const antwort = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": `${login}-contribution-calendar`},
    body: JSON.stringify({query: abfrage, variables: {login, von: `${isoAus(start)}T00:00:00Z`, bis}}),
  })
  if (!antwort.ok) {
    console.error(`::error::GraphQL request failed: HTTP ${antwort.status} ${antwort.statusText}.`)
    process.exit(1)
  }
  const nutzlast = await antwort.json()
  if (nutzlast.errors?.length) {
    for (const fehler of nutzlast.errors)
      console.error(`::error::GraphQL error: ${fehler.message}`)
    process.exit(1)
  }
  const kalender = nutzlast.data?.user?.contributionsCollection?.contributionCalendar
  if (!kalender?.weeks?.length) {
    console.error(`::error::GraphQL answered without a contribution calendar for "${login}". The token may not be allowed to read this user.`)
    process.exit(1)
  }
  return kalender.weeks.flatMap(woche => woche.contributionDays).map(tag => ({date: tag.date, count: tag.contributionCount}))
}

function ausDatei() {
  const roh = JSON.parse(readFileSync(fixture, "utf8"))
  if (!Array.isArray(roh) || !roh.length) {
    console.error(`::error::Fixture ${fixture} holds no days.`)
    process.exit(1)
  }
  return roh.map(tag => ({date: tag.date, count: Number(tag.count) || 0}))
}

const gemeldet = fixture ? ausDatei() : await ausApi()
const zaehler = new Map(gemeldet.map(tag => [tag.date, tag.count]))

// The grid is built from the window, not from the answer: a day the API leaves
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

const ZELLE = 11, ABSTAND = 3, SCHRITT = ZELLE + ABSTAND
const LINKS = 30, OBEN = 34
const gitterBreite = spalten * SCHRITT - ABSTAND
const BREITE = LINKS + gitterBreite + 16
const HOEHE = OBEN + 7 * SCHRITT - ABSTAND + 46

const monate = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const esc = text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const zahl = n => n.toLocaleString("en-US")
const langDatum = iso => `${Number(iso.slice(8, 10))} ${monate[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`

// Month label above the first column that carries a new month, kept apart so
// two labels never overlap.
const beschriftungen = []
let letzterMonat = -1, letztesX = -Infinity
for (let spalte = 0; spalte < spalten; spalte++) {
  const erster = tage[spalte * 7]
  if (!erster)
    continue
  const monat = erster.tag.getUTCMonth()
  const x = LINKS + spalte * SCHRITT
  if (monat !== letzterMonat && x - letztesX >= 28) {
    beschriftungen.push({x, text: monate[monat]})
    letzterMonat = monat
    letztesX = x
  }
}

let zellen = ""
for (const [index, tag] of tage.entries()) {
  const spalte = Math.floor(index / 7), reihe = index % 7
  const x = LINKS + spalte * SCHRITT
  const y = OBEN + reihe * SCHRITT
  const titel = `${tag.count === 0 ? "No contributions" : `${zahl(tag.count)} contribution${tag.count === 1 ? "" : "s"}`} on ${langDatum(tag.iso)}`
  zellen += `\n    <rect class="s${stufe(tag.count)}" x="${x}" y="${y}" width="${ZELLE}" height="${ZELLE}" rx="2"><title>${esc(titel)}</title></rect>`
}

// Legend, laid out from the right edge inwards so the word "More" stays inside
// the viewBox at any window length.
const MEHR_BREIT = 26, WENIGER_BREIT = 24, LUFT = 5
const mehrX = BREITE - 16 - MEHR_BREIT
const feldX = mehrX - LUFT - (5 * SCHRITT - ABSTAND)
const wenigerX = feldX - LUFT - WENIGER_BREIT
const legendeY = OBEN + 7 * SCHRITT - ABSTAND + 16
let legende = ""
for (let s = 0; s <= 4; s++)
  legende += `\n    <rect class="s${s}" x="${feldX + s * SCHRITT}" y="${legendeY}" width="${ZELLE}" height="${ZELLE}" rx="2"/>`

const kopf = `${zahl(gesamt)} contribution${gesamt === 1 ? "" : "s"} in the last ${Math.round(days / 30.5)} months`
const fuss = `${langDatum(isoAus(start))} – ${langDatum(heute)}  ·  ${aktiv} active day${aktiv === 1 ? "" : "s"}  ·  longest streak ${laengste}  ·  current streak ${strecke}`

// Two files instead of one file with a media query: README.md picks the theme
// through <picture>, the same way the process graphic does. Each file then
// shows its own palette when it is opened on its own as well.
const paletten = {
  light: {kopf: "#1C2143", klein: "#6B6F80", fuss: "#8A8E9C", stufen: ["#E9E6E0", "#BFC2D2", "#8E93AE", "#4E5686", "#1C2143"]},
  dark: {kopf: "#E6E9F2", klein: "#9AA0B4", fuss: "#7F8598", stufen: ["#1F2340", "#33395F", "#4E5786", "#8A93B8", "#CFBDA2"]},
}

const zeichne = palette => `<svg xmlns="http://www.w3.org/2000/svg" width="${BREITE}" height="${HOEHE}" viewBox="0 0 ${BREITE} ${HOEHE}" role="img" aria-label="${esc(kopf)}">
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .kopf { font-size: 13px; font-weight: 600; fill: ${palette.kopf}; }
    .klein { font-size: 9px; fill: ${palette.klein}; }
    .fuss  { font-size: 9px; fill: ${palette.fuss}; }
    ${palette.stufen.map((farbe, s) => `.s${s} { fill: ${farbe}; }`).join(" ")}
  </style>
  <text class="kopf" x="${LINKS}" y="15">${esc(kopf)}</text>
  ${beschriftungen.map(({x, text}) => `<text class="klein" x="${x}" y="${OBEN - 6}">${text}</text>`).join("\n  ")}
  <text class="klein" x="0" y="${OBEN + SCHRITT + 9}">Mon</text>
  <text class="klein" x="0" y="${OBEN + 3 * SCHRITT + 9}">Wed</text>
  <text class="klein" x="0" y="${OBEN + 5 * SCHRITT + 9}">Fri</text>${zellen}
  <text class="klein" x="${wenigerX}" y="${legendeY + 9}">Less</text>${legende}
  <text class="klein" x="${mehrX}" y="${legendeY + 9}">More</text>
  <text class="fuss" x="${LINKS}" y="${HOEHE - 8}">${esc(fuss)}</text>
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
// readable as "no new contributions" instead of "nothing happened".
const bericht = {
  dateien: geschrieben,
  quelle: fixture ? `fixture ${fixture}` : "GitHub GraphQL",
  login,
  fenster: `${isoAus(start)}..${heute}`,
  tage: tage.length,
  wochen: spalten,
  beitraege: gesamt,
  aktive_tage: aktiv,
  hoechster_tag: hoechst,
  laengste_strecke: laengste,
  aktuelle_strecke: strecke,
  zeitpunkt: new Date().toISOString(),
}
console.log(`geschrieben ${JSON.stringify(bericht)}`)
if (gesamt === 0)
  console.log(`::warning::${login} has no contributions in ${isoAus(start)}..${heute}. The calendar is empty.`)

if (process.env.GITHUB_OUTPUT) {
  const bytes = Object.values(geschrieben).map(datei => datei.bytes).join(" / ")
  writeFileSync(process.env.GITHUB_OUTPUT, `beitraege=${gesamt}\nfenster=${isoAus(start)}..${heute}\nbytes=${bytes}\n`, {flag: "a"})
}
