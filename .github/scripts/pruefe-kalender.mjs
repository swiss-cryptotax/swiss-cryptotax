#!/usr/bin/env node
// Checks render-commits.mjs against the promises the card makes.
//
// Each check names what is checked and the mutation that breaks it. A check
// without a mutation that turns it red measures whatever is easy to measure,
// not the promise; the mutation is written down so the next reader can repeat
// it instead of trusting this comment.
//
// The drawing is checked against a fixture of its own. With a second argument,
// the data file the card is drawn from is checked as well: the renderer has to
// draw every day of it with the count the file names.
//
// Usage: node .github/scripts/pruefe-kalender.mjs [render-commits.mjs] [commits-daten.json]
// Exit codes: 0 all checks green, 1 at least one red, 2 the check itself broke.

import {spawnSync} from "node:child_process"
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"

const hier = dirname(fileURLToPath(import.meta.url))
const renderer = resolve(process.argv[2] || join(hier, "render-commits.mjs"))
const daten = process.argv[3] ? resolve(process.argv[3]) : null
const ZONE = "Europe/Zurich"

// The card that was delivered before this one, as the baseline for "bigger".
const ALT_BREITE = 480, ALT_HOEHE = 330
const FAKTOR = 1.5

const abbruch = (text, code = 2) => {
  console.error(`::error::${text}`)
  process.exit(code)
}

// ------------------------------------------------------------------ rendern

const arbeit = mkdtempSync(join(tmpdir(), "kalenderprobe-"))
const heute = new Intl.DateTimeFormat("en-CA", {timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date())

// A fixture wider than any window the renderer may ask for: days it does not
// use stay unread, days it uses are all present. Counts rise and fall so the
// card carries every level and several distinct heights, and the current day
// carries commits — a day drawn only when it is empty proves nothing.
const fixtureTage = []
for (let i = 400; i >= 0; i--) {
  const tag = new Date(new Date(`${heute}T00:00:00Z`).getTime() - i * 86400000).toISOString().slice(0, 10)
  const muster = [0, 0, 1, 2, 3, 5, 8, 13, 21, 0, 4, 7, 0, 34, 0, 2]
  fixtureTage.push({date: tag, count: i === 0 ? 17 : muster[i % muster.length]})
}
const fixture = join(arbeit, "fixture.json")
writeFileSync(fixture, JSON.stringify(fixtureTage))

// Runs the renderer on one data file. Returns its exit status, its output and,
// when it wrote, the report and both files.
const rendere = (datenDatei, name) => {
  const pfade = {light: join(arbeit, `${name}-light.svg`), dark: join(arbeit, `${name}-dark.svg`)}
  const lauf = spawnSync(process.execPath, [renderer], {
    encoding: "utf8",
    env: {
      ...process.env,
      CAL_DATA: datenDatei,
      CAL_OUT_LIGHT: pfade.light,
      CAL_OUT_DARK: pfade.dark,
      CAL_TZ: ZONE,
      CAL_DAYS: process.env.CAL_DAYS || "183",
      GITHUB_OUTPUT: "",
    },
  })
  if (lauf.error)
    abbruch(`The renderer could not be started: ${lauf.error.message}`)
  const ergebnis = {status: lauf.status, stdout: lauf.stdout, stderr: lauf.stderr}
  if (lauf.status !== 0)
    return ergebnis
  const berichtZeile = lauf.stdout.split("\n").find(zeile => zeile.startsWith("geschrieben "))
  if (!berichtZeile)
    abbruch(`The renderer wrote no report line for ${name}. Without it the window is unknown and nothing can be checked.`)
  ergebnis.bericht = JSON.parse(berichtZeile.slice("geschrieben ".length))
  ergebnis.quelle = {light: readFileSync(pfade.light, "utf8"), dark: readFileSync(pfade.dark, "utf8")}
  return ergebnis
}

const probe = rendere(fixture, "fixture")
if (probe.status !== 0)
  abbruch(`The renderer refused its own fixture: ${probe.stderr}`)
const {bericht, quelle} = probe

// ------------------------------------------------------------------- lesen

// Paths in document order. A lid carries a <title>; the legend blocks carry
// none, which is what separates the grid from the key below it.
const pfadMuster = /<path class="([olr])(\d)" d="([^"]*)"(?:><title>([^<]*)<\/title><\/path>|\s*\/>)/g

const punkte = d => {
  const zahlen = d.replace(/[MZz]/g, " ").trim().split(/[\s,]+/).map(Number)
  const liste = []
  for (let i = 0; i + 1 < zahlen.length; i += 2)
    liste.push({x: zahlen[i], y: zahlen[i + 1]})
  return liste
}

const lies = text => {
  const bloecke = []
  let offen = {}
  for (const treffer of text.matchAll(pfadMuster)) {
    const [, art, stufe, d, titel] = treffer
    const p = punkte(d)
    if (art === "l")
      offen.hoehe = Math.round((p[3].y - p[0].y) * 100) / 100
    else if (art === "o") {
      const hoehe = offen.hoehe ?? 0
      bloecke.push({stufe: Number(stufe), titel: titel ?? null, x: p[0].x, halb: Math.round((p[1].x - p[0].x) * 100) / 100, deckelY: p[1].y, hoehe, bodenY: Math.round((p[1].y + hoehe) * 100) / 100})
      offen = {}
    }
  }
  return bloecke
}

const bloecke = {light: lies(quelle.light), dark: lies(quelle.dark)}
const gitter = bloecke.light.filter(block => block.titel)

const anzahl = titel => {
  const treffer = titel.match(/^([\d,]+) commits? on /)
  return treffer ? Number(treffer[1].replace(/,/g, "")) : 0
}
const datum = titel => titel.replace(/^.* on /, "")

// ------------------------------------------------------------------ pruefen

const ergebnisse = []
const pruefe = (name, zusicherung, mutation, urteil) => {
  let ok = false, bemerkung = ""
  try {
    const antwort = urteil()
    ok = antwort === true
    bemerkung = antwort === true ? "" : String(antwort)
  } catch (fehler) {
    abbruch(`Check "${name}" broke while running: ${fehler.stack}`)
  }
  ergebnisse.push({name, zusicherung, mutation, ok, bemerkung})
}

pruefe(
  "groesse",
  `the card is at least ${FAKTOR}x the delivered isometric card of ${ALT_BREITE} x ${ALT_HOEHE} in both dimensions`,
  "set BREITE in render-commits.mjs to 470",
  () => {
    const masse = name => {
      const kopf = quelle[name].match(/<svg[^>]*width="(\d+)"[^>]*height="(\d+)"/)
      if (!kopf)
        return null
      return {breite: Number(kopf[1]), hoehe: Number(kopf[2])}
    }
    for (const name of ["light", "dark"]) {
      const m = masse(name)
      if (!m)
        return `${name}: the SVG carries no width and height on its root element`
      if (m.breite < ALT_BREITE * FAKTOR || m.hoehe < ALT_HOEHE * FAKTOR)
        return `${name}: ${m.breite} x ${m.hoehe}, required at least ${Math.ceil(ALT_BREITE * FAKTOR)} x ${Math.ceil(ALT_HOEHE * FAKTOR)}`
    }
    return true
  },
)

pruefe(
  "vollstaendig",
  "every day of the window is drawn exactly once, and the days drawn are the days of the window",
  "skip one column in the block loop, for example: if (c === 3) continue",
  () => {
    if (gitter.length !== bericht.tage)
      return `${gitter.length} lids with a date, ${bericht.tage} days in the window`
    const daten = new Set(gitter.map(block => datum(block.titel)))
    if (daten.size !== gitter.length)
      return `${gitter.length} lids but only ${daten.size} distinct dates: a day is drawn twice`
    return true
  },
)

pruefe(
  "laufender-tag",
  `the last day of the window is the current day in ${ZONE} and it is drawn`,
  "end the window a day earlier: ende = plusTage(tagAus(heute), -1)",
  () => {
    if (!bericht.fenster.endsWith(heute))
      return `the report names the window ${bericht.fenster}, the current day is ${heute}`
    const monate = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    const erwartet = `${Number(heute.slice(8, 10))} ${monate[Number(heute.slice(5, 7)) - 1]} ${heute.slice(0, 4)}`
    const letzter = gitter.find(block => datum(block.titel) === erwartet)
    if (!letzter)
      return `no lid carries the current day "${erwartet}"`
    if (letzter.hoehe <= 0)
      return `the current day carries ${anzahl(letzter.titel)} commits but is drawn flat`
    return true
  },
)

pruefe(
  "hoehe-folgt-der-zahl",
  "a day with more commits is drawn as a taller block than a day with fewer, and a day without commits stays flat",
  "make the height constant: saeule = count => count <= 0 ? 0 : SOCKEL",
  () => {
    const sortiert = [...gitter].sort((links, rechts) => anzahl(links.titel) - anzahl(rechts.titel))
    for (let i = 1; i < sortiert.length; i++) {
      const klein = sortiert[i - 1], gross = sortiert[i]
      const nk = anzahl(klein.titel), ng = anzahl(gross.titel)
      if (nk === ng) {
        if (klein.hoehe !== gross.hoehe)
          return `${nk} commits drawn at two heights, ${klein.hoehe} and ${gross.hoehe}`
        continue
      }
      if (!(gross.hoehe > klein.hoehe))
        return `${ng} commits at height ${gross.hoehe}, ${nk} commits at height ${klein.hoehe}: more is not taller`
    }
    const leer = gitter.filter(block => anzahl(block.titel) === 0)
    if (!leer.length)
      return "no empty day in the window: the flat case is untested"
    if (leer.some(block => block.hoehe !== 0))
      return "an empty day is drawn raised"
    const hoehen = new Set(gitter.map(block => block.hoehe))
    if (hoehen.size < 4)
      return `only ${hoehen.size} distinct heights in the whole card: the third dimension carries nothing`
    return true
  },
)

pruefe(
  "koerper-nicht-flaeche",
  "a raised block shows three faces in three different colours — lid, lit side, shaded side — and the shaded side is the darkest of the three",
  "let the shading return the palette value unchanged: tonen = hex => hex",
  () => {
    const helligkeit = hex => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const benutzt = new Set(gitter.filter(block => block.hoehe > 0).map(block => block.stufe))
    if (benutzt.size < 2)
      return `only ${benutzt.size} level(s) are drawn raised: the shading is barely exercised`
    for (const name of ["light", "dark"]) {
      for (const stufe of benutzt) {
        const farbe = art => {
          const treffer = quelle[name].match(new RegExp(`\\.${art}${stufe} \\{ fill: (#[0-9a-fA-F]{6}); \\}`))
          return treffer ? treffer[1].toLowerCase() : null
        }
        const deckel = farbe("o"), rechts = farbe("r"), links = farbe("l")
        if (!deckel || !rechts || !links)
          return `${name}: level ${stufe} has no complete set of lid, lit side and shaded side`
        if (new Set([deckel, rechts, links]).size !== 3)
          return `${name}: level ${stufe} paints its faces in ${new Set([deckel, rechts, links]).size} colour(s): ${deckel} ${rechts} ${links}`
        if (!(helligkeit(links) < helligkeit(rechts) && helligkeit(rechts) < helligkeit(deckel)))
          return `${name}: level ${stufe} is not lit from one side: lid ${deckel}, lit ${rechts}, shaded ${links}`
      }
      // A raised block must actually carry both side faces in the file.
      const seiten = [...quelle[name].matchAll(/<path class="([lr])\d"/g)].length
      const erhoben = lies(quelle[name]).filter(block => block.hoehe > 0).length
      if (seiten !== 2 * erhoben)
        return `${name}: ${erhoben} raised blocks but ${seiten} side faces, expected ${2 * erhoben}`
    }
    return true
  },
)

pruefe(
  "fuge-zwischen-den-tagen",
  "two neighbouring days keep a seam between them, so a week without commits still reads as seven days and not as one slab",
  "draw the blocks at full pitch: ZA = a, ZB = b",
  () => {
    const xWerte = [...new Set(gitter.map(block => block.x))].sort((links, rechts) => links - rechts)
    if (xWerte.length < 3)
      return `only ${xWerte.length} distinct block positions: the pitch of the grid cannot be measured`
    let schritt = Infinity
    for (let i = 1; i < xWerte.length; i++)
      schritt = Math.min(schritt, xWerte[i] - xWerte[i - 1])
    const halb = [...new Set(gitter.map(block => block.halb))]
    if (halb.length !== 1)
      return `the lids are drawn at ${halb.length} different widths: ${halb.join(", ")}`
    if (halb[0] >= schritt)
      return `lid half width ${halb[0]} at a grid pitch of ${schritt}: neighbouring days touch and merge into one surface`
    if (halb[0] < 0.85 * schritt)
      return `lid half width ${halb[0]} at a grid pitch of ${schritt}: the seam eats more than a seventh of the block`
    return true
  },
)

pruefe(
  "reihenfolge-hinten-nach-vorn",
  "blocks are written back to front: a block further from the viewer never appears after a block in front of it, otherwise it paints over it",
  "reverse the depth sort: .sort((links, rechts) => (rechts.c + rechts.r) - (links.c + links.r))",
  () => {
    for (let i = 1; i < gitter.length; i++) {
      if (gitter[i].bodenY < gitter[i - 1].bodenY - 0.05)
        return `block ${i} stands on ${gitter[i].bodenY}, the block written before it on ${gitter[i - 1].bodenY}: the back is drawn over the front`
    }
    return true
  },
)

pruefe(
  "hell-und-dunkel",
  "light and dark carry the same geometry and differ only in the palette, and each one carries its house colour as the strongest level",
  "change a coordinate in one palette only, for example draw the dark card at BREITE - 1",
  () => {
    const ohneStil = text => text.replace(/<style>[\s\S]*?<\/style>/, "")
    if (ohneStil(quelle.light) !== ohneStil(quelle.dark))
      return "the two files differ outside their <style> block: the geometry is not the same"
    const stil = text => text.match(/<style>[\s\S]*?<\/style>/)[0]
    if (stil(quelle.light) === stil(quelle.dark))
      return "both files carry the same palette: the dark card is the light one"
    if (!/\.o4 \{ fill: #1C2143; \}/i.test(quelle.light))
      return "the light card does not carry #1C2143 as its strongest level"
    if (!/\.o4 \{ fill: #CFBDA2; \}/i.test(quelle.dark))
      return "the dark card does not carry #CFBDA2 as its strongest level"
    return true
  },
)

// Files the renderer has to refuse. Each one differs from an accepted file in
// one point, and each point is a way a name or a text could reach the card.
const falscheDaten = [
  ["an extra key", '[{"date":"2026-09-01","count":3,"repo":"orbit"}]'],
  ["a key written twice", '[{"date":"a commit message","date":"2026-09-01","count":3}]'],
  ["keys in another order", '[{"count":3,"date":"2026-09-01"}]'],
  ["a missing count", '[{"date":"2026-09-01"}]'],
  ["a count written as text", '[{"date":"2026-09-01","count":"3"}]'],
  ["a count in another notation", '[{"date":"2026-09-01","count":3e0}]'],
  ["a negative count", '[{"date":"2026-09-01","count":-1}]'],
  ["a fractional count", '[{"date":"2026-09-01","count":1.5}]'],
  ["a date in another form", '[{"date":"01.09.2026","count":3}]'],
  ["a day that does not exist", '[{"date":"2026-02-30","count":3}]'],
  ["the same day twice", '[{"date":"2026-09-01","count":3},{"date":"2026-09-01","count":1}]'],
  ["days out of order", '[{"date":"2026-09-02","count":3},{"date":"2026-09-01","count":1}]'],
  ["an entry that is not an object", '["orbit"]'],
  ["an object instead of a list", '{"2026-09-01":3}'],
  ["an empty list", "[]"],
]

pruefe(
  "form-der-daten",
  "the renderer draws only from a list of {date, count} in exactly that form — one entry per line is accepted — and refuses every other form, so no name and no text reaches the card",
  "accept whatever parses: let liesDaten return JSON.parse(readFileSync(datei, \"utf8\"))",
  () => {
    const zeilen = join(arbeit, "zeilen.json")
    writeFileSync(zeilen, `[\n${fixtureTage.map(tag => JSON.stringify(tag)).join(",\n")}\n]\n`)
    const angenommen = rendere(zeilen, "zeilen")
    if (angenommen.status !== 0)
      return `the renderer refused the fixture written one entry per line: ${angenommen.stderr.trim()}`
    for (const [i, [was, inhalt]] of falscheDaten.entries()) {
      const pfad = join(arbeit, `falsch-${i}.json`)
      writeFileSync(pfad, inhalt)
      const lauf = rendere(pfad, `falsch-${i}`)
      if (lauf.status === 0)
        return `the renderer drew a file with ${was}: ${inhalt}`
      if (lauf.status !== 1 || !lauf.stderr.includes("::error::"))
        return `the renderer ended with status ${lauf.status} and no refusal for a file with ${was}`
    }
    return true
  },
)

if (daten) {
  const echt = rendere(daten, "daten")
  const monate = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const titelMuster = new RegExp(`^(?:No commits|([\\d,]+) commits?) on (\\d{1,2}) (${monate.join("|")}) (\\d{4})$`)
  pruefe(
    "jeder-tag-der-daten",
    `the card drawn from ${daten} shows every day of its window with the count the file names, and its total is the sum of the file over that window`,
    "lose one day of the file before drawing, for example after the Map is built: zaehler.delete(gemeldet.at(-1).date)",
    () => {
      if (echt.status !== 0)
        return `the renderer refused the data file: ${echt.stderr.trim()}`
      const [von, bis] = echt.bericht.fenster.split("..")
      const erwartet = new Map(JSON.parse(readFileSync(daten, "utf8"))
        .filter(tag => tag.date >= von && tag.date <= bis)
        .map(tag => [tag.date, tag.count]))
      const summe = [...erwartet.values()].reduce((a, b) => a + b, 0)
      if (summe === 0)
        return `the file names no commit in ${echt.bericht.fenster}: there is nothing to compare`
      if (echt.bericht.commits !== summe)
        return `the renderer reports ${echt.bericht.commits} commits for ${echt.bericht.fenster}, the file holds ${summe} there`
      const gezeichnet = new Map()
      for (const block of lies(echt.quelle.light).filter(block => block.titel)) {
        const t = block.titel.match(titelMuster)
        if (!t)
          return `a lid carries a title this check cannot read: "${block.titel}"`
        const iso = `${t[4]}-${String(monate.indexOf(t[3]) + 1).padStart(2, "0")}-${t[2].padStart(2, "0")}`
        gezeichnet.set(iso, t[1] ? Number(t[1].replace(/,/g, "")) : 0)
      }
      if (gezeichnet.size !== echt.bericht.tage)
        return `${gezeichnet.size} distinct days drawn, ${echt.bericht.tage} days in the window`
      for (const [tag, n] of erwartet)
        if (gezeichnet.get(tag) !== n)
          return `the file names ${n} commits on ${tag}, the card draws ${gezeichnet.has(tag) ? gezeichnet.get(tag) : "no such day"}`
      for (const [tag, n] of gezeichnet)
        if (n !== (erwartet.get(tag) ?? 0))
          return `the card draws ${n} commits on ${tag}, the file names ${erwartet.get(tag) ?? 0}`
      return true
    },
  )
}

// ------------------------------------------------------------------ bericht

rmSync(arbeit, {recursive: true, force: true})

let rot = 0
for (const {name, zusicherung, mutation, ok, bemerkung} of ergebnisse) {
  if (ok) {
    console.log(`gruen  ${name}: ${zusicherung}`)
  } else {
    rot++
    console.log(`ROT    ${name}: ${zusicherung}`)
    console.log(`       found: ${bemerkung}`)
    console.log(`       the mutation this check exists for: ${mutation}`)
    console.error(`::error::${name}: ${bemerkung}`)
  }
}
console.log(`${ergebnisse.length - rot} of ${ergebnisse.length} checks green, window ${bericht.fenster}, ${bericht.tage} days, card ${quelle.light.match(/width="(\d+)" height="(\d+)"/).slice(1, 3).join(" x ")}${daten ? `, data ${daten}` : ", no data file given"}`)
process.exit(rot ? 1 : 0)
