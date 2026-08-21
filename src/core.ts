/**
 * EDIT LAYOUT — the model behind the on-page composition editor.
 *
 * The editor is a review layer, never the source of truth: it records deltas
 * on top of whatever the React tree already renders, and exports them for a
 * human to implement. Nothing here mutates the component tree, and every
 * visual change is expressed as a CSS custom property so the baseline styles
 * stay readable underneath (see `--baked-*` vs `--edit-*` below).
 */

export type Breakpoint = "desktop" | "tablet" | "mobile"
export type EditMode = "safe" | "concept"
export type Level = "frames" | "inner" | "graphics"

export type Operation =
  | "move"
  | "resize"
  | "style"
  | "reorder"
  | "reparent"
  | "hide"
  | "remove"
  | "text"
  | "comment"

export interface EditRecord {
  /** Stable id — see `elementId()`. Never text- or nth-child-derived. */
  id: string
  /** React component the element belongs to, when it could be determined. */
  component?: string
  /** Layout container the element lives in today. */
  from?: string
  /** Container it was dragged into. Only ever set in concept mode. */
  to?: string
  order?: number
  x?: number
  y?: number
  w?: number
  h?: number
  rotation?: number
  z?: number
  color?: string
  background?: string
  border?: string
  align?: "left" | "center" | "right"
  fontSize?: number
  fontWeight?: number
  padding?: number
  gap?: number
  /** Rewritten copy. Only ever set on a leaf — see `applyRecord`. */
  text?: string
  /**
   * What the reviewer said about this element, in their words.
   *
   * Kept apart from `notes`, which the editor writes itself. Whoever
   * implements the export needs to know which sentences are a human's intent
   * and which are the tool describing what it observed — they carry very
   * different authority.
   */
  comment?: string
  /** Hidden but still occupying its space. */
  hidden?: boolean
  /** Taken out of the flow entirely, so the layout closes up around it. */
  removed?: boolean
  mode: EditMode
  operation: Operation
  classification: "css-safe" | "structural-change"
  notes?: string[]
}

export type Draft = Record<string, EditRecord>
export type Drafts = Record<Breakpoint, Draft>

export const EMPTY_DRAFTS: Drafts = { desktop: {}, tablet: {}, mobile: {} }

/**
 * Bumped whenever a draft is implemented for real. An old draft then refuses
 * to load rather than stacking its deltas on top of the new baseline CSS —
 * the failure mode is invisible otherwise, because the page still "looks
 * edited" and you chase a bug that lives in localStorage.
 */
export const STORAGE_VERSION = 1
export const storageKey = (page: string) =>
  `edit-layout.v${STORAGE_VERSION}.${page}`

/* ── Breakpoints ─────────────────────────────────────────────────────────── */

export function currentBreakpoint(width: number): Breakpoint {
  if (width < 768) return "mobile"
  if (width < 1160) return "tablet"
  return "desktop"
}

/* ── Stable ids ──────────────────────────────────────────────────────────── */

/**
 * An id that survives copy edits and unrelated DOM churn.
 *
 * `data-edit-id` wins when the page provides one. Otherwise the id is a path
 * of *signatures* — the element's own meaningful class (or tag), plus its
 * index among siblings sharing that same signature. Deliberately not
 * nth-child: inserting an unrelated sibling shifts every nth-child index,
 * while the signature index only shifts if you add another element of the
 * same kind, which is exactly when the id SHOULD change.
 */
const UTILITY_CLASS =
  /^(?:[a-z]+:)*(?:m|p|w|h|gap|flex|grid|text|bg|border|rounded|absolute|relative|fixed|sticky|inline|block|hidden|items|justify|self|order|z|opacity|shadow|overflow|min|max|space|leading|tracking|font|cursor|transition|duration|ease|hover|focus|group|sm|md|lg|xl)[-:[]/.test(
    ""
  )
    ? /never/
    : /^(?:sm|md|lg|xl|2xl|hover|focus|group|peer|dark|print|motion|first|last|odd|even):|^(?:-?(?:m|p)[trblxy]?-|w-|h-|min-|max-|gap-|flex|grid|inline|block|hidden$|absolute$|relative$|fixed$|sticky$|static$|items-|justify-|self-|order-|z-|opacity-|shadow|rounded|border(?:$|-)|bg-|text-|font-|leading-|tracking-|whitespace-|overflow-|space-|divide-|cursor-|transition|duration-|ease-|scale-|rotate-|translate-|origin-|truncate$|sr-only$|antialiased$|pointer-events-|select-|scroll-|backdrop-|ring|outline|animate-|aspect-|object-|top-|right-|bottom-|left-|inset-|basis-|shrink|grow|col-|row-|place-|content-|underline$|uppercase$|lowercase$|capitalize$|not-|\[)/

function signature(el: Element): string {
  const explicit = el.getAttribute("data-edit-id")
  if (explicit) return explicit
  const testid = el.getAttribute("data-testid")
  if (testid) return testid
  const classes = Array.from(el.classList).filter((c) => !UTILITY_CLASS.test(c))
  if (classes.length > 0) return classes[0]
  return el.tagName.toLowerCase()
}

export function elementId(el: Element, root: Element): string {
  const explicit = el.getAttribute("data-edit-id")
  if (explicit) return explicit
  const parts: string[] = []
  let node: Element | null = el
  while (node && node !== root) {
    const sig = signature(node)
    const parent: Element | null = node.parentElement
    let index = 0
    if (parent) {
      const twins = Array.from(parent.children).filter(
        (c) => signature(c) === sig
      )
      index = twins.indexOf(node)
      if (twins.length === 1) index = -1
    }
    parts.unshift(index >= 0 ? `${sig}[${index}]` : sig)
    if (node.getAttribute("data-edit-id")) break
    node = parent
  }
  return parts.join("/")
}

/**
 * The nearest ancestor that behaves as a layout container. Used for the
 * production-safe boundary and for `from` / `to` in a structural record.
 */
export function containerOf(el: Element, root: Element): Element {
  let node = el.parentElement
  while (node && node !== root) {
    const cs = getComputedStyle(node)
    if (
      cs.display.includes("flex") ||
      cs.display.includes("grid") ||
      node.hasAttribute("data-edit-container")
    ) {
      return node
    }
    node = node.parentElement
  }
  return (el.parentElement as Element) ?? root
}

/**
 * React's component name for the fibre that rendered this node, when the dev
 * build exposes it. Best-effort by design: it is a label in the export, never
 * something the editor depends on.
 */
/**
 * Framework plumbing that shows up in the fibre chain. Naming one of these in
 * an export would be worse than naming nothing: it reads like a component the
 * reader could go and open, and they'd find a router internal.
 *
 * Matched on the suffix rather than a list of names, because the list keeps
 * growing — `SegmentViewNode` and `LayoutRouterContext` both turned up on one
 * server-rendered page. A page with no client components has no component name
 * to give, and saying so is the honest answer.
 */
const INTERNAL_FIBRE_SUFFIX =
  /(?:Context|Provider|Consumer|Boundary|Router|Node|Root|Segment|Loader|Handler|Bailout|Fragment|Portal|Shell)$/

export function componentName(el: Element): string | undefined {
  const key = Object.keys(el).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternal")
  )
  if (!key) return undefined
  let fiber = (el as unknown as Record<string, unknown>)[key] as {
    return?: unknown
    type?: unknown
  } | null
  for (let i = 0; i < 12 && fiber; i++) {
    const type = fiber.type as
      | { displayName?: string; name?: string }
      | string
      | undefined
    if (type && typeof type !== "string") {
      const name = type.displayName || type.name
      if (name && /^[A-Z]/.test(name) && !INTERNAL_FIBRE_SUFFIX.test(name)) {
        return name
      }
    }
    fiber = (fiber.return ?? null) as typeof fiber
  }
  return undefined
}

/**
 * Short, meaningful ids for the elements a reviewer reaches for, stamped onto
 * the DOM at scan time rather than written into the components.
 *
 * The generated path id (`div/section[0]/div[1]/hero-title/…`) is
 * stable but unreadable, and an export full of those is hostile to whoever
 * implements it. Stamping from here keeps the page's own components free of
 * attributes that exist only for a dev tool — they usually render on other
 * surfaces too, where this editor never runs.
 *
 * The map is per-page and passed in: what counts as a landmark on a dashboard
 * is nothing like what counts as one on an article page.
 */
export type StableIdMap = Array<[selector: string, id: string]>

/** Idempotent: re-stamping an already-stamped tree is a no-op. */
export function stampStableIds(root: Element, map: StableIdMap) {
  for (const [selector, id] of map) {
    const found = Array.from(root.querySelectorAll(selector))
    found.forEach((el, i) => {
      if (el.hasAttribute("data-edit-id")) return
      el.setAttribute("data-edit-id", found.length > 1 ? `${id}-${i + 1}` : id)
    })
  }
}

/* ── Classification ──────────────────────────────────────────────────────── */

const GRAPHIC_TAGS = new Set(["svg", "path", "circle", "line", "canvas", "hr"])
const FRAME_HINT =
  /panel|card|section|grid|row$|list|wrapper|container|bar$|group|screen|stack|column/

export function levelOf(el: Element): Level {
  const tag = el.tagName.toLowerCase()
  if (GRAPHIC_TAGS.has(tag) || el.hasAttribute("data-edit-graphic")) {
    return "graphics"
  }
  const sig = signature(el)
  const box = el.getBoundingClientRect()
  // Decoration, whatever the tag says: a hairline, a bar, an indicator dot.
  // An empty box — no children, no text — is drawing something and nothing
  // else, which catches an 8px dot that a size threshold alone missed.
  if (el.childElementCount === 0 && !el.textContent?.trim()) return "graphics"
  if (box.height <= 12 || box.width <= 12) return "graphics"
  // Anything that lays other elements out is a frame. INNER is the leaf tier —
  // the label, the amount, the button — which is what you actually want the
  // first click to land on when you picked that level. A looser threshold here
  // put a whole page wrapper in INNER, so clicking a heading selected the page
  // instead of the heading.
  if (FRAME_HINT.test(sig) || el.childElementCount >= 2) return "frames"
  return "inner"
}

/** Hit rect, widened so a 3px rule or a 6px dot is still clickable. */
export function hitRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect()
  const padX = Math.max(0, (24 - r.width) / 2)
  const padY = Math.max(0, (24 - r.height) / 2)
  return new DOMRect(
    r.x - padX,
    r.y - padY,
    r.width + padX * 2,
    r.height + padY * 2
  )
}

/* ── Baked baseline ──────────────────────────────────────────────────────── */

export interface Baked {
  x: number
  y: number
  rotation: number
}

/**
 * The element's own transform, read once before we touch it. Kept separate
 * from the edit delta so the preview is baseline + delta and STRAIGHTEN can
 * cancel an original rotation instead of pretending there was none.
 */
export function readBaked(el: Element): Baked {
  const t = getComputedStyle(el).transform
  if (!t || t === "none") return { x: 0, y: 0, rotation: 0 }
  const m = new DOMMatrixReadOnly(t)
  return {
    x: round(m.e),
    y: round(m.f),
    rotation: round((Math.atan2(m.b, m.a) * 180) / Math.PI, 2),
  }
}

/** Pointer maths produces 0.7333px. Nobody wants that in an export. */
export function round(n: number, dp = 0): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/**
 * Snap to the spacing step.
 *
 * A hand dragging a mouse lands on 13px, and 13px is not a decision — it is
 * the pointer's noise wearing the costume of one. Snapping while the value is
 * recorded, rather than tidying it up at export time, keeps the preview honest:
 * what the reviewer sees on the page is the number the export will carry.
 */
export function snap(n: number, step: number): number {
  if (!Number.isFinite(step) || step <= 1) return round(n)
  return Math.round(n / step) * step
}

/* ── Applying a draft to the DOM ─────────────────────────────────────────── */

const VAR_MAP: Array<[keyof EditRecord, string, string]> = [
  ["x", "--edit-x", "px"],
  ["y", "--edit-y", "px"],
  ["w", "--edit-w", "px"],
  ["h", "--edit-h", "px"],
  ["rotation", "--edit-rot", "deg"],
  ["fontSize", "--edit-fs", "px"],
  ["padding", "--edit-pad", "px"],
  ["gap", "--edit-gap", "px"],
]

export function applyRecord(el: HTMLElement, rec: EditRecord | undefined) {
  if (!rec) {
    el.removeAttribute("data-le-edited")
    el.removeAttribute("data-le-commented")
    for (const [, name] of VAR_MAP) el.style.removeProperty(name)
    for (const name of [
      "--edit-z",
      "--edit-color",
      "--edit-bg",
      "--edit-border",
      "--edit-align",
      "--edit-fw",
      "--baked-x",
      "--baked-y",
      "--baked-rot",
    ]) {
      el.style.removeProperty(name)
    }
    el.style.visibility = ""
    el.style.display = ""
    const original = textCache.get(el)
    if (original !== undefined && el.textContent !== original) {
      el.textContent = original
    }
    return
  }
  const baked = readBakedCached(el)
  el.setAttribute("data-le-edited", "")
  // Marked on the page, not just in the panel: a reviewer who wrote six
  // comments needs to see which six elements carry them without clicking
  // through the whole screen again.
  if (rec.comment) el.setAttribute("data-le-commented", "")
  else el.removeAttribute("data-le-commented")
  el.style.setProperty("--baked-x", `${baked.x}px`)
  el.style.setProperty("--baked-y", `${baked.y}px`)
  el.style.setProperty("--baked-rot", `${baked.rotation}deg`)
  for (const [field, name, unit] of VAR_MAP) {
    const value = rec[field] as number | undefined
    if (typeof value === "number") {
      el.style.setProperty(name, `${value}${unit}`)
    } else {
      el.style.removeProperty(name)
    }
  }
  setOrClear(el, "--edit-z", rec.z !== undefined ? String(rec.z) : undefined)
  setOrClear(el, "--edit-color", rec.color)
  setOrClear(el, "--edit-bg", rec.background)
  setOrClear(el, "--edit-border", rec.border)
  setOrClear(el, "--edit-align", rec.align)
  setOrClear(
    el,
    "--edit-fw",
    rec.fontWeight !== undefined ? String(rec.fontWeight) : undefined
  )
  // Copy is edited on leaves only. Writing textContent on a node with element
  // children would delete them, and a design tool that silently eats a button
  // is worse than one that can't edit that node.
  if (rec.text !== undefined && el.childElementCount === 0) {
    originalText(el)
    if (el.textContent !== rec.text) el.textContent = rec.text
  }
  // Two different questions a reviewer asks: "what if this weren't showing"
  // (keep the space) and "what if this weren't here" (close the gap).
  el.style.visibility = rec.hidden ? "hidden" : ""
  el.style.display = rec.removed ? "none" : ""
  if (el.tagName.toLowerCase() === "canvas") notifyCanvas(el, rec)
}

function setOrClear(el: HTMLElement, name: string, value?: string) {
  if (value) el.style.setProperty(name, value)
  else el.style.removeProperty(name)
}

/**
 * A canvas can't be restyled from the outside: CSS `color` does nothing to
 * pixels, and setting width/height in CSS stretches the bitmap, which is what
 * turns circles into eggs. So the editor asks the renderer to redraw instead,
 * handing it CSS pixels and the device ratio; a renderer that listens sizes
 * its backing store itself and keeps `arc()` circular by scaling X and Y
 * equally. This path is the hook, not a claim: it has not been exercised
 * against a real canvas renderer.
 */
function notifyCanvas(el: HTMLElement, rec: EditRecord) {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new CustomEvent("layout-editor:canvas", {
      bubbles: true,
      detail: {
        cssWidth: rec.w ?? r.width,
        cssHeight: rec.h ?? r.height,
        dpr: window.devicePixelRatio || 1,
        color: rec.color,
        background: rec.background,
        border: rec.border,
      },
    })
  )
}

/**
 * The element's copy as the page wrote it, remembered the first time it is
 * edited so closing the editor can put it back verbatim.
 */
const textCache = new WeakMap<Element, string>()
export function originalText(el: Element): string {
  const hit = textCache.get(el)
  if (hit !== undefined) return hit
  const current = el.textContent ?? ""
  textCache.set(el, current)
  return current
}

const bakedCache = new WeakMap<Element, Baked>()
function readBakedCached(el: Element): Baked {
  const hit = bakedCache.get(el)
  if (hit) return hit
  const baked = readBaked(el)
  bakedCache.set(el, baked)
  return baked
}
export function forgetBaked(el: Element) {
  bakedCache.delete(el)
  textCache.delete(el)
}
