/**
 * The handoff back to whoever implements this — usually a coding agent.
 *
 * `Copy JSON` is the complete record and is meant for a machine; the design
 * snapshot is a picture and is meant for a person. Neither is what you paste
 * into a chat. This is: one markdown document that says what the reviewer
 * wanted, in their words, with the measurements underneath and the rules for
 * turning them into code — self-contained, so the agent reading it does not
 * need this repository to make sense of it.
 */

import type { Breakpoint, Drafts, EditRecord } from "./core"

const BREAKPOINTS: Breakpoint[] = ["desktop", "tablet", "mobile"]

/** "moved 16 left, 8 up · width 320 · font-size 44" — only what changed. */
function describe(r: EditRecord): string {
  const bits: string[] = []
  const move: string[] = []
  if (r.x) move.push(`${Math.abs(r.x)}px ${r.x < 0 ? "left" : "right"}`)
  if (r.y) move.push(`${Math.abs(r.y)}px ${r.y < 0 ? "up" : "down"}`)
  if (move.length > 0) bits.push(`moved ${move.join(", ")}`)
  if (r.w !== undefined) bits.push(`width ${r.w}`)
  if (r.h !== undefined) bits.push(`height ${r.h}`)
  if (r.fontSize !== undefined) bits.push(`font-size ${r.fontSize}`)
  if (r.fontWeight !== undefined) bits.push(`font-weight ${r.fontWeight}`)
  if (r.padding !== undefined) bits.push(`padding ${r.padding}`)
  if (r.gap !== undefined) bits.push(`gap ${r.gap}`)
  if (r.align) bits.push(`aligned ${r.align}`)
  if (r.color) bits.push(`text ${r.color}`)
  if (r.background) bits.push(`fill ${r.background}`)
  if (r.border) bits.push(`border ${r.border}`)
  if (r.rotation !== undefined) bits.push(`rotation ${r.rotation}°`)
  if (r.z !== undefined) bits.push(`z ${r.z}`)
  if (r.to) bits.push(`moved into \`${r.to}\``)
  if (r.text !== undefined) bits.push(`copy rewritten to "${r.text}"`)
  if (r.removed) bits.push("removed from the flow")
  else if (r.hidden) bits.push("hidden, space kept")
  return bits.length > 0 ? bits.join(" · ") : "comment only, nothing moved"
}

function table(rows: EditRecord[]): string {
  const head =
    "| element | component | in | change | classification |\n" +
    "| --- | --- | --- | --- | --- |"
  const body = rows
    .map((r) =>
      [
        "`" + r.id + "`",
        r.component ? "`" + r.component + "`" : "—",
        r.from ? "`" + r.from + "`" : "—",
        describe(r),
        r.classification,
      ].join(" | ")
    )
    .map((line) => `| ${line} |`)
    .join("\n")
  return `${head}\n${body}`
}

export function buildBrief(
  page: string,
  drafts: Drafts,
  snapStep: number
): string {
  const edited = BREAKPOINTS.filter((b) => Object.keys(drafts[b]).length > 0)
  if (edited.length === 0) {
    return `# EDIT LAYOUT — \`${page}\`\n\nNothing was changed.\n`
  }

  const commented = edited.flatMap((b) =>
    Object.values(drafts[b])
      .filter((r) => r.comment)
      .map((r) => ({ bp: b, r }))
  )
  const structural = edited.flatMap((b) =>
    Object.values(drafts[b]).filter(
      (r) => r.classification === "structural-change"
    )
  )

  const out: string[] = []
  out.push(`# EDIT LAYOUT — review of \`${page}\``)
  out.push(
    "Somebody recomposed this page in the browser and left what follows. " +
      "The React tree was never modified: every row below is an **intent to " +
      "implement**, not a diff to apply."
  )
  out.push(
    `Breakpoints edited: ${edited.join(", ")}. ` +
      (snapStep > 1
        ? `Geometry was recorded on ${snapStep === 8 ? "an" : "a"} ${snapStep}px step, so the numbers are ` +
          "decisions rather than pointer noise — keep them on that step."
        : "Geometry was recorded at 1px, so round before implementing.")
  )

  if (commented.length > 0) {
    out.push("## What the reviewer said")
    out.push(
      "Their words, and the most important part of this document. Where a " +
        "comment and a measurement disagree, the comment is the intent and " +
        "the measurement is one attempt at it."
    )
    out.push(
      commented
        .map(
          ({ bp, r }) =>
            `- **\`${r.id}\`** _(${bp}${r.component ? `, ${r.component}` : ""})_ — ${r.comment}`
        )
        .join("\n")
    )
  }

  out.push("## Changes")
  for (const b of edited) {
    out.push(`### ${b}`)
    out.push(table(Object.values(drafts[b])))
  }

  out.push("## How to implement this")
  out.push(
    [
      "1. Look for the pattern before the instance. One card nudged usually",
      "   means the grid's gap is wrong, not that one card needs a transform.",
      "2. `css-safe` rows become spacing, Grid/Flex placement, props or tokens",
      "   on the existing component — never absolute positioning that imitates",
      "   the screenshot.",
      "3. Reordering goes through JSX or data order, Grid areas, or Flex",
      "   `order`.",
      structural.length > 0
        ? `4. ${structural.length} ${structural.length === 1 ? "row is" : "rows are"} \`structural-change\`: a refactor, not a\n   tweak. If one cannot be mapped back safely, say so and write a spec\n   instead of forcing it.`
        : "4. Nothing here is structural, so no refactor is implied.",
      "5. Values typed into the panel by hand were left exactly as typed — a",
      "   typed number is a decision. Dragged values are on the step above.",
      "6. When it is implemented, bump `STORAGE_VERSION` in the editor's",
      "   `core.ts`, so an old local draft cannot stack its deltas on the new",
      "   baseline. That failure is invisible: the page still looks edited.",
    ].join("\n")
  )

  return out.join("\n\n") + "\n"
}
