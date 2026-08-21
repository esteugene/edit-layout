/**
 * DESIGN SNAPSHOT — a view-only artifact of the edited composition.
 *
 * Deliberately not "export to React". It is a frozen picture plus the notes an
 * implementer needs: which element maps to which component, what is a CSS
 * tweak, what needs a refactor. Anything that claimed to be production code
 * would be a lie, because the editor never sees the component tree — only the
 * DOM it rendered.
 */

import type { Breakpoint, Draft, Drafts, EditRecord } from "./core"

export interface Capture {
  breakpoint: Breakpoint
  width: number
  html: string
}

/** Same-origin stylesheet text, so the snapshot renders without the app. */
export function collectStyles(): string {
  const out: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules
      if (!rules) continue
      for (const rule of Array.from(rules)) {
        // The editor's own rules would ride along otherwise. The markup is
        // already stripped, so they style nothing — but a design reference
        // containing the tool that made it invites the wrong questions.
        const selector = (rule as CSSStyleRule).selectorText
        if (selector && /(^|[\s,])(\.le-|\[data-le-)/.test(selector)) continue
        out.push(rule.cssText)
      }
    } catch {
      // A cross-origin sheet throws on `cssRules`. Nothing to do about it, and
      // nothing of ours lives in one — skip rather than fail the export.
    }
  }
  return out.join("\n")
}

export function captureBreakpoint(
  root: HTMLElement,
  breakpoint: Breakpoint
): Capture {
  const clone = root.cloneNode(true) as HTMLElement
  // The editor's own chrome must never appear in the artifact.
  clone.querySelectorAll("[data-le-chrome]").forEach((n) => n.remove())
  return {
    breakpoint,
    width: Math.round(root.getBoundingClientRect().width),
    html: clone.outerHTML,
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string
  )
}

function changeRows(draft: Draft): {
  safe: EditRecord[]
  structural: EditRecord[]
} {
  const all = Object.values(draft)
  return {
    safe: all.filter((r) => r.classification === "css-safe"),
    structural: all.filter((r) => r.classification === "structural-change"),
  }
}

function recordLine(r: EditRecord): string {
  const bits: string[] = []
  if (r.x || r.y) bits.push(`moved ${r.x ?? 0}, ${r.y ?? 0}`)
  if (r.w || r.h) bits.push(`sized ${r.w ?? "auto"} × ${r.h ?? "auto"}`)
  if (r.rotation) bits.push(`rotated ${r.rotation}°`)
  if (r.z !== undefined) bits.push(`z ${r.z}`)
  if (r.color) bits.push(`colour ${r.color}`)
  if (r.background) bits.push(`background ${r.background}`)
  if (r.border) bits.push(`border ${r.border}`)
  if (r.align) bits.push(`aligned ${r.align}`)
  if (r.fontSize) bits.push(`font-size ${r.fontSize}px`)
  if (r.fontWeight) bits.push(`font-weight ${r.fontWeight}`)
  if (r.padding !== undefined) bits.push(`padding ${r.padding}px`)
  if (r.gap !== undefined) bits.push(`gap ${r.gap}px`)
  if (r.text !== undefined) bits.push(`copy → “${r.text}”`)
  if (r.hidden) bits.push("hidden")
  if (r.removed) bits.push("removed")
  if (r.to) bits.push(`moved into ${r.to}`)
  return `<tr>
    <td><code>${escapeHtml(r.id)}</code></td>
    <td>${escapeHtml(r.component ?? "—")}</td>
    <td>${escapeHtml(r.from ?? "—")}</td>
    <td>${escapeHtml(bits.join(", ") || r.operation)}</td>
    <td>${escapeHtml((r.notes ?? []).join(" "))}</td>
  </tr>`
}

export function buildSnapshot(
  drafts: Drafts,
  captures: Capture[],
  pageLabel: string
): string {
  const styles = collectStyles()
  const order: Breakpoint[] = ["desktop", "tablet", "mobile"]

  const sections = order
    .map((bp) => {
      const capture = captures.find((c) => c.breakpoint === bp)
      if (!capture) {
        return `<section><h2>${bp}</h2><p class="miss">Not captured. Resize the window to this breakpoint and capture it again.</p></section>`
      }
      return `<section>
        <h2>${bp} <small>${capture.width}px</small></h2>
        <div class="frame" style="width:${capture.width}px">${capture.html}</div>
      </section>`
    })
    .join("\n")

  const tables = order
    .map((bp) => {
      const { safe, structural } = changeRows(drafts[bp])
      if (safe.length === 0 && structural.length === 0) return ""
      const table = (rows: EditRecord[], title: string, note: string) =>
        rows.length === 0
          ? ""
          : `<h4>${title}</h4><p class="note">${note}</p>
             <table><thead><tr><th>Element</th><th>Component</th><th>Container</th><th>Change</th><th>Notes</th></tr></thead>
             <tbody>${rows.map(recordLine).join("")}</tbody></table>`
      return `<section class="changes">
        <h3>${bp}</h3>
        ${table(safe, "CSS-safe changes", "Implementable with CSS, Grid/Flex, props or tokens inside the existing container.")}
        ${table(structural, "Structural changes", "Each one needs a React refactor. Treat as a proposal, not a diff.")}
      </section>`
    })
    .join("\n")

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design reference — ${escapeHtml(pageLabel)}</title>
<style>${styles}</style>
<style>
  body { margin:0; background:#0f1216; color:#e7e9ee; font-family:ui-sans-serif,system-ui,sans-serif; }
  .wrap { max-width:1400px; margin:0 auto; padding:32px 24px 80px; }
  .stamp { padding:14px 18px; border:2px solid #b45309; background:rgba(180,83,9,.15);
           color:#fbbf24; border-radius:8px; font-weight:700; letter-spacing:.08em; }
  h1 { font-size:20px; margin:24px 0 4px; }
  .sub { color:#9aa3b2; font-size:13px; margin:0 0 28px; }
  section { margin:32px 0; }
  section h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#9aa3b2; }
  section h2 small { color:#5d6675; font-weight:400; }
  .frame { margin-top:12px; background:#f6f6f6; color:#111; border-radius:8px; overflow:hidden;
           box-shadow:0 8px 40px rgba(0,0,0,.4); }
  .miss { color:#7c8496; font-style:italic; }
  .changes h3 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#9aa3b2; }
  .changes h4 { margin:18px 0 2px; font-size:13px; }
  .note { margin:0 0 8px; color:#7c8496; font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid #262c37; vertical-align:top; }
  th { color:#9aa3b2; font-weight:600; }
  code { font-family:ui-monospace,Menlo,monospace; color:#9ec1ff; }
  .impl { margin-top:40px; padding:16px 18px; border:1px solid #262c37; border-radius:8px; line-height:1.6; }
</style></head>
<body><div class="wrap">
  <p class="stamp">DESIGN REFERENCE — NOT PRODUCTION CODE</p>
  <h1>${escapeHtml(pageLabel)}</h1>
  <p class="sub">Captured from the running application with EDIT LAYOUT. The compositions below are frozen HTML: they show the intended result, not how it should be built.</p>
  ${sections}
  ${tables}
  <div class="impl">
    <b>For the implementer.</b> Every row above names the element by its stable editing id and, where React exposed it, the component that rendered it.
    CSS-safe rows can go in as spacing, Grid/Flex placement, props or tokens on the existing component.
    Structural rows moved an element across a component boundary — implement them by changing JSX or data order, not by absolutely positioning the element to match this picture.
    Where a repeated component was adjusted once, apply the pattern to every instance rather than to the one that was dragged.
  </div>
</div></body></html>`
}
