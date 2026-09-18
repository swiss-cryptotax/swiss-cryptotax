#!/usr/bin/env node
// Checks render-contributions.mjs against the promises the card makes.
//
// Each check names what is checked and the mutation that breaks it. A check
// without a mutation that turns it red measures whatever is easy to measure,
// not the promise; the mutation is written down so the next reader can repeat
// it instead of trusting this comment.
//
// Usage: node .github/scripts/pruefe-kalender.mjs [path to render-contributions.mjs]
// Exit codes: 0 all checks green, 1 at least one red, 2 the check itself broke.

import {execFileSync} from "node:child_process"
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"

const hier = dirname(fileURLToPath(import.meta.url))
const renderer = resolve(process.argv[2] || join(hier, "render-contributions.mjs"))
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
// carries contributions — a day drawn only when it is empty proves nothing.
const fixtureTage = []
for (let i = 400; i >= 0; i--) {
  const tag = new Date(new Date(`${heute}T00:00:00Z`).getTime() - i * 86400000).toISOString().slice(0, 10)
  const muster = [0, 0, 1, 2, 3, 5, 8, 13, 21, 0, 4, 7, 0, 34, 0, 2]
  fixtureTage.push({date: tag, count: i === 0 ? 17 : muster[i % muster.length]})
}
const fixture = join(arbeit, "fixture.json")
writeFileSync(fixture, JSON.stringify(fixtureTage))

const pfade = {light: join(arbeit, "light.svg"), dark: join(arbeit, "dark.svg")}
let ausgabe
try {
  ausgabe = execFileSync(process.execPath, [renderer], {
    encoding: "utf8",
    env: {
      ...process.env,
      CAL_LOGIN: "probe",
      CAL_OUT_LIGHT: pfade.light,
      CAL_OUT_DARK: pfade.dark,
      CAL_FIXTURE: fixture,
      CAL_TZ: ZONE,
      CAL_DAYS: process.env.CAL_DAYS || "183",
      GITHUB_OUTPUT: "",
    },
  })
} catch (fehler) {
  abbruch(`The renderer refused to run: ${fehler.stderr || fehler.message}`)
}

const berichtZeile = ausgabe.split("\n").find(zeile => zeile.startsWith("geschrieben "))
if (!berichtZeile)
  abbruch("The renderer wrote no report line. Without it the window is unknown and nothing can be checked.")
const bericht = JSON.parse(berichtZeile.slice("geschrieben ".length))

const quelle = {light: readFileSync(pfade.light, "utf8"), dark: readFileSync(pfade.dark, "utf8")}

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
  const treffer = titel.match(/^([\d,]+) contributions? on /)
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
  "set BREITE in render-contributions.mjs to 470",
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
      return `the current day carries ${anzahl(letzter.titel)} contributions but is drawn flat`
    return true
  },
)

pruefe(
  "hoehe-folgt-beitraegen",
  "a day with more contributions is drawn as a taller block than a day with fewer, and a day without contributions stays flat",
  "make the height constant: saeule = count => count <= 0 ? 0 : SOCKEL",
  () => {
    const sortiert = [...gitter].sort((links, rechts) => anzahl(links.titel) - anzahl(rechts.titel))
    for (let i = 1; i < sortiert.length; i++) {
      const klein = sortiert[i - 1], gross = sortiert[i]
      const nk = anzahl(klein.titel), ng = anzahl(gross.titel)
      if (nk === ng) {
        if (klein.hoehe !== gross.hoehe)
          return `${nk} contributions drawn at two heights, ${klein.hoehe} and ${gross.hoehe}`
        continue
      }
      if (!(gross.hoehe > klein.hoehe))
        return `${ng} contributions at height ${gross.hoehe}, ${nk} contributions at height ${klein.hoehe}: more is not taller`
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
  "two neighbouring days keep a seam between them, so a week without contributions still reads as seven days and not as one slab",
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
console.log(`${ergebnisse.length - rot} of ${ergebnisse.length} checks green, window ${bericht.fenster}, ${bericht.tage} days, card ${quelle.light.match(/width="(\d+)" height="(\d+)"/).slice(1, 3).join(" x ")}`)
process.exit(rot ? 1 : 0)
