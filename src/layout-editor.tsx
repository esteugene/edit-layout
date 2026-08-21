"use client"

// The editor's own chrome uses a neutral palette so it reads as tooling over
// the page rather than as part of the host interface. Nothing here renders in
// production.

/**
 * EDIT LAYOUT — a composition editor that runs on top of the real page.
 *
 * It never touches the React tree. Selection, movement and styling are stored
 * as deltas keyed by a stable element id and previewed through CSS custom
 * properties; the export is what a human implements afterwards. Closing the
 * editor restores the page exactly.
 *
 * Responsiveness is a design constraint, not a nice-to-have — a dragged
 * element that lags behind the pointer makes the tool feel broken. So the drag
 * path deliberately bypasses React: it writes the CSS variable straight onto
 * the element and only commits to state on pointerup. The selection frame is a
 * single box moved by one rAF loop rather than nine components re-rendering
 * per frame, and the DOM scan is cached and invalidated by a MutationObserver
 * instead of being re-walked on every pointer event.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  EMPTY_DRAFTS,
  applyRecord,
  componentName,
  containerOf,
  currentBreakpoint,
  elementId,
  forgetBaked,
  hitRect,
  levelOf,
  originalText,
  readBaked,
  round,
  stampStableIds,
  storageKey,
  type Breakpoint,
  type Draft,
  type Drafts,
  type EditMode,
  type EditRecord,
  type Level,
  type StableIdMap,
} from "./core"
import { buildSnapshot, captureBreakpoint, type Capture } from "./snapshot"
import "./layout-editor.css"

interface Props {
  rootSelector: string
  page: string
  /** Landmark selectors for this page — see `StableIdMap` in core.ts. */
  stableIds?: StableIdMap
}

type Handle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w"
type PanelMode = "dock" | "float"

const HANDLES: Array<[Handle, string, string]> = [
  ["nw", "0%", "0%"],
  ["n", "50%", "0%"],
  ["ne", "100%", "0%"],
  ["e", "100%", "50%"],
  ["se", "100%", "100%"],
  ["s", "50%", "100%"],
  ["sw", "0%", "100%"],
  ["w", "0%", "50%"],
]

const LEVELS: Level[] = ["frames", "inner", "graphics"]

interface DragTarget {
  id: string
  el: HTMLElement
  baseX: number
  baseY: number
  /**
   * How far this element may travel before it leaves its own container, in
   * layout pixels, measured once at the start of the gesture. Measuring it
   * live is self-referential — the rect already contains the delta you are
   * about to clamp against it — and it drifts.
   */
  minDx: number
  maxDx: number
  minDy: number
  maxDy: number
}

interface Drag {
  kind: "move" | Handle
  id: string
  el: HTMLElement
  /** Everything the gesture moves — one entry for a resize, N for a move. */
  targets: DragTarget[]
  startX: number
  startY: number
  baseX: number
  baseY: number
  baseW: number
  baseH: number
  container: string
  live: Partial<EditRecord>
  /** Flips once the pointer clears the slop radius — see the move handler. */
  started: boolean
}

export default function LayoutEditor({
  rootSelector,
  page,
  stableIds = [],
}: Props) {
  const [on, setOn] = useState(false)
  const [level, setLevel] = useState<Level>("frames")
  const [mode, setMode] = useState<EditMode>("safe")
  const [panelMode, setPanelMode] = useState<PanelMode>("dock")
  const [panelPos, setPanelPos] = useState({ x: 24, y: 24 })
  // A selection is a list. The last one clicked is primary: it carries the
  // handles and the numeric fields, because resizing or setting an exact X for
  // several elements at once means nothing.
  const [ids, setIds] = useState<string[]>([])
  const [zoom, setZoom] = useState(1)
  const [drafts, setDrafts] = useState<Drafts>(EMPTY_DRAFTS)
  const [past, setPast] = useState<Drafts[]>([])
  const [future, setFuture] = useState<Drafts[]>([])
  const [bp, setBp] = useState<Breakpoint>("desktop")
  const [toast, setToast] = useState<string | null>(null)
  const [showHits, setShowHits] = useState(false)
  const [captures, setCaptures] = useState<Capture[]>([])

  const frameRef = useRef<HTMLDivElement>(null)
  const registry = useRef(new Map<string, HTMLElement>())
  const elements = useRef<HTMLElement[]>([])
  const dirty = useRef(true)
  const drag = useRef<Drag | null>(null)
  const cycle = useRef({ x: -1, y: -1, index: 0 })
  const fileInput = useRef<HTMLInputElement>(null)
  const panelDrag = useRef<{ dx: number; dy: number } | null>(null)
  const marks = useRef(new Map<string, HTMLDivElement>())
  const zoomRef = useRef(1)

  const selected = ids.length > 0 ? ids[ids.length - 1] : null
  const draft = drafts[bp]
  const record = selected ? draft[selected] : undefined

  const root = useCallback(
    () => document.querySelector<HTMLElement>(rootSelector),
    [rootSelector]
  )

  const say = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }, [])

  /* ── Breakpoint ──────────────────────────────────────────────────────── */

  useEffect(() => {
    const read = () => setBp(currentBreakpoint(window.innerWidth))
    read()
    window.addEventListener("resize", read)
    return () => window.removeEventListener("resize", read)
  }, [])

  /* ── Persistence ─────────────────────────────────────────────────────── */

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey(page))
      if (raw) setDrafts({ ...EMPTY_DRAFTS, ...JSON.parse(raw) })
    } catch {
      // A corrupt draft is not worth breaking the page over.
    }
  }, [page])

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey(page), JSON.stringify(drafts))
    } catch {
      // Quota or private mode — editing works, it just won't persist.
    }
  }, [drafts, page])

  /* ── Scanning, cached ────────────────────────────────────────────────── */

  const scan = useCallback((): HTMLElement[] => {
    if (!dirty.current) return elements.current
    const container = root()
    if (!container) return []
    stampStableIds(container, stableIds)
    const map = registry.current
    map.clear()
    const out: HTMLElement[] = []
    container.querySelectorAll<HTMLElement>("*").forEach((el) => {
      if (el.closest("[data-le-chrome]")) return
      const rect = el.getBoundingClientRect()
      // A removed element measures zero. Keep it in the registry anyway, or
      // the draft can't be re-applied — or undone — after a reload.
      if (
        rect.width === 0 &&
        rect.height === 0 &&
        !el.hasAttribute("data-le-edited")
      ) {
        return
      }
      const id = elementId(el, container)
      if (!map.has(id)) map.set(id, el)
      out.push(el)
    })
    elements.current = out
    dirty.current = false
    return out
  }, [root, stableIds])

  // The page's DOM only changes when the app changes it — a step advancing, a
  // row expanding. Watching for that is far cheaper than re-walking the tree on
  // every pointer event, which is what made dragging feel like treacle.
  useEffect(() => {
    if (!on) return
    const container = root()
    if (!container) return
    dirty.current = true
    const observer = new MutationObserver(() => {
      dirty.current = true
    })
    observer.observe(container, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [on, root])

  const elementFor = useCallback(
    (id: string): HTMLElement | undefined => {
      scan()
      const hit = registry.current.get(id)
      if (hit?.isConnected) return hit
      dirty.current = true
      scan()
      return registry.current.get(id)
    },
    [scan]
  )

  /* ── Applying the draft ──────────────────────────────────────────────── */

  useEffect(() => {
    if (!on) return
    const seen = new Set<string>()
    for (const [id, rec] of Object.entries(draft)) {
      const el = elementFor(id)
      if (el) {
        applyRecord(el, rec)
        seen.add(id)
      }
    }
    const container = root()
    if (!container) return
    document.querySelectorAll<HTMLElement>("[data-le-edited]").forEach((el) => {
      if (!seen.has(elementId(el, container))) {
        applyRecord(el, undefined)
        forgetBaked(el)
      }
    })
  }, [on, draft, elementFor, root])

  useEffect(() => {
    if (on) return
    document.querySelectorAll<HTMLElement>("[data-le-edited]").forEach((el) => {
      applyRecord(el, undefined)
      forgetBaked(el)
    })
  }, [on])

  /* ── Docking ─────────────────────────────────────────────────────────── */

  // Docked, the panel is a column beside the page rather than on top of it:
  // the body gives up that width, so nothing is hidden behind the panel and
  // the page reflows into the space it actually has.
  useEffect(() => {
    const docked = on && panelMode === "dock"
    document.documentElement.toggleAttribute("data-le-docked", docked)
    return () => document.documentElement.removeAttribute("data-le-docked")
  }, [on, panelMode])

  // Zoom the region being edited, not the whole window: the panel and the
  // browser chrome stay at their own size. `zoom` reflows rather than scaling
  // a bitmap, so `getBoundingClientRect` keeps returning boxes the overlay can
  // use directly — the one thing that has to be corrected is the pointer
  // delta, which arrives in screen pixels (see the move handler).
  useEffect(() => {
    zoomRef.current = zoom
    const container = root()
    if (!container) return
    container.style.zoom = zoom === 1 ? "" : String(zoom)
    return () => {
      container.style.zoom = ""
    }
  }, [zoom, root, on])

  /* ── History ─────────────────────────────────────────────────────────── */

  const commit = useCallback(
    (next: Drafts) => {
      setPast((p) => [...p.slice(-49), drafts])
      setFuture([])
      setDrafts(next)
    },
    [drafts]
  )

  const patch = useCallback(
    (id: string, changes: Partial<EditRecord>) => {
      const before = drafts[bp][id]
      const el = elementFor(id)
      const container = root()
      const base: EditRecord = before ?? {
        id,
        mode,
        operation: "move",
        classification: "css-safe",
      }
      const next: EditRecord = {
        ...base,
        component: base.component ?? (el ? componentName(el) : undefined),
        from:
          base.from ??
          (el && container
            ? elementId(containerOf(el, container), container)
            : undefined),
        mode,
        ...changes,
      }
      commit({ ...drafts, [bp]: { ...drafts[bp], [id]: next } })
    },
    [bp, commit, drafts, elementFor, mode, root]
  )

  /** Several elements changed by one gesture — still one history entry. */
  const patchMany = useCallback(
    (changes: Map<string, Partial<EditRecord>>) => {
      if (changes.size === 0) return
      const container = root()
      const next: Draft = { ...drafts[bp] }
      for (const [id, change] of changes) {
        const before = next[id]
        const el = elementFor(id)
        const base: EditRecord = before ?? {
          id,
          mode,
          operation: "move",
          classification: "css-safe",
        }
        next[id] = {
          ...base,
          component: base.component ?? (el ? componentName(el) : undefined),
          from:
            base.from ??
            (el && container
              ? elementId(containerOf(el, container), container)
              : undefined),
          mode,
          ...change,
        }
      }
      commit({ ...drafts, [bp]: next })
    },
    [bp, commit, drafts, elementFor, mode, root]
  )

  /**
   * Delete takes the element out of the flow so the layout closes up — the
   * question a reviewer is actually asking. `Hide` keeps the space. Selection
   * clears afterwards, because a frame around a zero-size box is noise; undo
   * or `Reset selected` brings it back.
   */
  const removeSelection = useCallback(() => {
    if (ids.length === 0) return
    patchMany(
      new Map(
        ids.map((id) => [id, { removed: true, operation: "remove" as const }])
      )
    )
    setIds([])
  }, [ids, patchMany])

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p
      setFuture((f) => [drafts, ...f])
      setDrafts(p[p.length - 1])
      return p.slice(0, -1)
    })
  }, [drafts])

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f
      setPast((p) => [...p, drafts])
      setDrafts(f[0])
      return f.slice(1)
    })
  }, [drafts])

  /* ── Hit testing ─────────────────────────────────────────────────────── */

  const candidatesAt = useCallback(
    (x: number, y: number, ignoreLevel = false): HTMLElement[] => {
      const depth = (el: Element) => {
        let d = 0
        let n: Element | null = el
        while (n) {
          d++
          n = n.parentElement
        }
        return d
      }
      const under = scan().filter((el) => {
        if (!ignoreLevel && levelOf(el) !== level) return false
        const r = hitRect(el)
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
      })
      // Deepest first: the first click lands on the thing under the cursor and
      // repeated clicks widen outwards. Alt drops the level filter to reach a
      // node the current level hides.
      return under.sort((a, b) => depth(b) - depth(a))
    },
    [level, scan]
  )

  const selectAt = useCallback(
    (x: number, y: number, deep: boolean, additive = false): string | null => {
      const container = root()
      const stack = candidatesAt(x, y, deep)
      if (stack.length === 0 || !container) {
        if (!additive) setIds([])
        return null
      }
      const near =
        Math.abs(cycle.current.x - x) < 5 && Math.abs(cycle.current.y - y) < 5
      const index = deep
        ? 0
        : near
          ? (cycle.current.index + 1) % stack.length
          : 0
      cycle.current = { x, y, index }
      const id = elementId(stack[index], container)
      setIds((cur) =>
        additive
          ? cur.includes(id)
            ? cur.filter((c) => c !== id)
            : [...cur, id]
          : [id]
      )
      return id
    },
    [candidatesAt, root]
  )

  /* ── Overlay geometry ────────────────────────────────────────────────── */

  // One box, four numbers per frame, written straight to the DOM. The handles
  // ride inside it on percentages, so keeping them in place costs nothing.
  useEffect(() => {
    if (!on) return
    let raf = 0
    let last = ""
    const sync = () => {
      raf = window.requestAnimationFrame(sync)
      const frame = frameRef.current
      if (!frame) return
      const el = selected ? registry.current.get(selected) : undefined
      if (!el?.isConnected) {
        if (last !== "none") {
          frame.style.display = "none"
          last = "none"
        }
        return
      }
      const r = el.getBoundingClientRect()
      const key = `${r.left}|${r.top}|${r.width}|${r.height}`
      for (const [id, mark] of marks.current) {
        const node = registry.current.get(id)
        if (!node?.isConnected) {
          mark.style.display = "none"
          continue
        }
        const mr = node.getBoundingClientRect()
        mark.style.display = "block"
        mark.style.transform = `translate(${mr.left}px, ${mr.top}px)`
        mark.style.width = `${mr.width}px`
        mark.style.height = `${mr.height}px`
      }
      if (key === last) return
      last = key
      frame.style.display = "block"
      frame.style.transform = `translate(${r.left}px, ${r.top}px)`
      frame.style.width = `${r.width}px`
      frame.style.height = `${r.height}px`
    }
    raf = window.requestAnimationFrame(sync)
    return () => window.cancelAnimationFrame(raf)
  }, [on, selected, ids])

  /* ── Dragging ────────────────────────────────────────────────────────── */

  const beginDrag = useCallback(
    (kind: Drag["kind"], id: string, e: React.PointerEvent) => {
      const el = elementFor(id)
      const container = root()
      if (!el || !container) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const rec = drafts[bp][id]
      // Prime the element once so each pointermove only writes one number.
      applyRecord(
        el,
        rec ?? { id, mode, operation: "move", classification: "css-safe" }
      )
      const group = kind === "move" && ids.includes(id) ? ids : [id]
      const targets: DragTarget[] = []
      for (const target of group) {
        const node = elementFor(target)
        if (!node) continue
        const own = drafts[bp][target]
        applyRecord(
          node,
          own ?? {
            id: target,
            mode,
            operation: "move",
            classification: "css-safe",
          }
        )
        const z0 = zoomRef.current || 1
        const r0 = node.getBoundingClientRect()
        const pr = containerOf(node, container).getBoundingClientRect()
        targets.push({
          id: target,
          el: node,
          baseX: own?.x ?? 0,
          baseY: own?.y ?? 0,
          minDx: (pr.left - r0.left) / z0,
          maxDx: (pr.right - r0.right) / z0,
          minDy: (pr.top - r0.top) / z0,
          maxDy: (pr.bottom - r0.bottom) / z0,
        })
      }
      drag.current = {
        kind,
        id,
        el,
        targets,
        startX: e.clientX,
        startY: e.clientY,
        baseX: rec?.x ?? 0,
        baseY: rec?.y ?? 0,
        baseW: round(rect.width),
        baseH: round(rect.height),
        container: elementId(containerOf(el, container), container),
        live: {},
        started: false,
      }
    },
    [bp, drafts, elementFor, ids, mode, root]
  )

  useEffect(() => {
    if (!on) return

    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const z = zoomRef.current || 1
      const dx = round((e.clientX - d.startX) / z)
      const dy = round((e.clientY - d.startY) / z)
      const container = root()
      if (!container) return
      // Slop radius: every press now arms a drag, so without this a plain
      // click would leave a 1px move behind in the export.
      if (!d.started) {
        if (Math.hypot(dx, dy) < 3) return
        d.started = true
      }

      if (d.kind === "move") {
        // ONE delta for the group, clamped by its most constrained member and
        // then applied to everybody. Clamping each element against its own
        // container instead lets one stop while the others keep going, which
        // pulls the selection out of shape as you drag it.
        let gx = dx
        let gy = dy
        if (mode === "safe") {
          const loX = Math.max(...d.targets.map((t) => t.minDx))
          const hiX = Math.min(...d.targets.map((t) => t.maxDx))
          const loY = Math.max(...d.targets.map((t) => t.minDy))
          const hiY = Math.min(...d.targets.map((t) => t.maxDy))
          // An element wider than its own container leaves no room to move at
          // all; freezing that axis beats letting the group tear.
          gx = loX > hiX ? 0 : Math.min(Math.max(gx, loX), hiX)
          gy = loY > hiY ? 0 : Math.min(Math.max(gy, loY), hiY)
        }
        for (const t of d.targets) {
          const nx = round(t.baseX + gx)
          const ny = round(t.baseY + gy)
          t.el.style.setProperty("--edit-x", `${nx}px`)
          t.el.style.setProperty("--edit-y", `${ny}px`)
          if (t.id === d.id) {
            d.live = { ...d.live, x: nx, y: ny, operation: "move" }
          }
        }
        return
      }

      const k = d.kind
      let w = d.baseW
      let h = d.baseH
      if (k.includes("e")) w = d.baseW + dx
      if (k.includes("w")) w = d.baseW - dx
      if (k.includes("s")) h = d.baseH + dy
      if (k.includes("n")) h = d.baseH - dy
      if (e.shiftKey) {
        const ratio = d.baseW / Math.max(1, d.baseH)
        if (Math.abs(dx) > Math.abs(dy)) h = round(w / ratio)
        else w = round(h * ratio)
      }
      w = Math.max(8, round(w))
      h = Math.max(8, round(h))
      d.live = { ...d.live, w, h, operation: "resize" }
      d.el.style.setProperty("--edit-w", `${w}px`)
      d.el.style.setProperty("--edit-h", `${h}px`)
    }

    // One gesture, one history entry: the moves above wrote straight to the
    // DOM, so React state is touched exactly once, here.
    const up = (e: PointerEvent) => {
      const d = drag.current
      drag.current = null
      if (!d || Object.keys(d.live).length === 0) return
      const container = root()
      if (!container) return

      const notes: string[] = []
      let classification: EditRecord["classification"] = "css-safe"
      let to: string | undefined
      let operation = d.live.operation ?? "move"

      if (mode === "concept" && d.kind === "move") {
        const dropped = document
          .elementsFromPoint(e.clientX, e.clientY)
          .find(
            (n) =>
              n !== d.el &&
              !n.closest("[data-le-chrome]") &&
              container.contains(n)
          )
        const dropContainer = dropped
          ? elementId(containerOf(dropped, container), container)
          : d.container
        if (dropContainer !== d.container) {
          classification = "structural-change"
          operation = "reparent"
          to = dropContainer
          notes.push(
            "Crossed a component boundary. Visual overlay only — the React tree was not changed."
          )
        }
      }

      // One commit for the whole gesture, however many elements it moved.
      const changes = new Map<string, Partial<EditRecord>>()
      if (d.kind === "move") {
        for (const t of d.targets) {
          const x =
            Number(t.el.style.getPropertyValue("--edit-x").replace("px", "")) ||
            0
          const y =
            Number(t.el.style.getPropertyValue("--edit-y").replace("px", "")) ||
            0
          changes.set(t.id, {
            x,
            y,
            from: d.container,
            to: t.id === d.id ? to : undefined,
            operation,
            classification,
            notes: notes.length > 0 && t.id === d.id ? notes : undefined,
          })
        }
      } else {
        changes.set(d.id, {
          ...d.live,
          from: d.container,
          operation,
          classification,
        })
      }
      patchMany(changes)
    }

    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
  }, [mode, on, patchMany, root])

  /* ── Panel dragging, float mode only ─────────────────────────────────── */

  useEffect(() => {
    if (!on || panelMode !== "float") return
    const move = (e: PointerEvent) => {
      const p = panelDrag.current
      if (!p) return
      setPanelPos({
        x: Math.max(0, e.clientX - p.dx),
        y: Math.max(0, e.clientY - p.dy),
      })
    }
    const up = () => {
      panelDrag.current = null
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
  }, [on, panelMode])

  /* ── Keyboard ────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!on) return
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault()
        redo()
        return
      }
      if (e.key === "Escape") {
        setIds([])
        return
      }
      if ((e.key === "Delete" || e.key === "Backspace") && ids.length > 0) {
        e.preventDefault()
        removeSelection()
        return
      }
      if (meta && (e.key === "=" || e.key === "+")) {
        e.preventDefault()
        setZoom((z) => Math.min(2, round(z + 0.1, 2)))
        return
      }
      if (meta && e.key === "-") {
        e.preventDefault()
        setZoom((z) => Math.max(0.25, round(z - 0.1, 2)))
        return
      }
      if (meta && e.key === "0") {
        e.preventDefault()
        setZoom(1)
        return
      }
      if (ids.length === 0 || !e.key.startsWith("Arrow")) return
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      const dx =
        e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0
      const changes = new Map<string, Partial<EditRecord>>()
      for (const id of ids) {
        const cur = drafts[bp][id]
        changes.set(id, {
          x: round((cur?.x ?? 0) + dx),
          y: round((cur?.y ?? 0) + dy),
          operation: "move",
        })
      }
      patchMany(changes)
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [bp, drafts, ids, on, patchMany, redo, removeSelection, undo])

  /* ── Selection metadata ──────────────────────────────────────────────── */

  const meta = useMemo(() => {
    if (!selected) return null
    const el = registry.current.get(selected)
    const container = root()
    if (!el || !container) return null
    return {
      id: selected,
      component: componentName(el) ?? "—",
      parent: elementId(containerOf(el, container), container),
      level: levelOf(el),
    }
  }, [selected, root])

  /* ── Export ──────────────────────────────────────────────────────────── */

  const exportJson = useCallback(() => {
    const rows = (Object.keys(drafts) as Breakpoint[]).flatMap((b) =>
      Object.values(drafts[b]).map((r) => ({ breakpoint: b, ...r }))
    )
    return JSON.stringify({ page, version: 1, changes: rows }, null, 2)
  }, [drafts, page])

  const download = useCallback((name: string, body: string, type: string) => {
    const url = URL.createObjectURL(new Blob([body], { type }))
    const a = document.createElement("a")
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  if (!on) {
    return (
      <button
        type="button"
        className="le-launcher"
        data-le-chrome=""
        onClick={() => setOn(true)}
      >
        EDIT LAYOUT
      </button>
    )
  }

  // Style-ish changes apply to the whole selection; geometry stays on the
  // primary, where an exact number means something.
  const styleAll = (changes: Partial<EditRecord>) =>
    patchMany(
      new Map(
        ids.map((id) => [id, { ...changes, operation: "style" as const }])
      )
    )
  const setColor = (field: "color" | "background" | "border", v?: string) =>
    styleAll({ [field]: v })

  const selectedEl = selected ? registry.current.get(selected) : undefined
  const editableText =
    selectedEl && selectedEl.childElementCount === 0
      ? (record?.text ?? originalText(selectedEl))
      : undefined

  return (
    <div className="le-root" data-le-chrome="" data-show-hits={showHits}>
      {/* Swallows page interaction while editing, so a click selects an
          element rather than activating the app underneath. */}
      <div
        className="le-capture"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          const el = selected ? registry.current.get(selected) : undefined
          const box = el?.getBoundingClientRect()
          const inside =
            box &&
            e.clientX >= box.left &&
            e.clientX <= box.right &&
            e.clientY >= box.top &&
            e.clientY <= box.bottom
          if (inside && selected) {
            beginDrag("move", selected, e)
            return
          }
          // Select and arm the drag in the same press. Requiring a separate
          // click first is what made the editor feel like it did nothing:
          // people press and pull in one motion.
          const id = selectAt(e.clientX, e.clientY, e.altKey, e.shiftKey)
          if (id && !e.shiftKey) beginDrag("move", id, e)
        }}
      />

      {ids.slice(0, -1).map((id) => (
        <div
          key={id}
          className="le-mark"
          ref={(el) => {
            if (el) marks.current.set(id, el)
            else marks.current.delete(id)
          }}
        />
      ))}

      <div
        ref={frameRef}
        className="le-frame"
        data-concept={String(mode === "concept")}
        style={{ display: "none" }}
      >
        <div className="le-select" />
        <div className="le-badge">
          <b>{meta?.component}</b>
          <span>{meta?.level}</span>
        </div>
        {selected &&
          HANDLES.map(([h, x, y]) => (
            <div
              key={h}
              className="le-handle"
              style={{ left: x, top: y, cursor: `${h}-resize` }}
              onPointerDown={(e) => {
                e.stopPropagation()
                beginDrag(h, selected, e)
              }}
            />
          ))}
      </div>

      <Panel
        bp={bp}
        mode={mode}
        setMode={setMode}
        panelMode={panelMode}
        setPanelMode={setPanelMode}
        panelPos={panelPos}
        onPanelGrab={(e) => {
          if (panelMode !== "float") return
          panelDrag.current = {
            dx: e.clientX - panelPos.x,
            dy: e.clientY - panelPos.y,
          }
        }}
        level={level}
        setLevel={setLevel}
        meta={meta}
        count={ids.length}
        zoom={zoom}
        setZoom={setZoom}
        record={record}
        showHits={showHits}
        setShowHits={setShowHits}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        onUndo={undo}
        onRedo={redo}
        onClose={() => setOn(false)}
        onPatch={(changes) => selected && patch(selected, changes)}
        onColor={setColor}
        onStyleAll={styleAll}
        onRemove={removeSelection}
        text={editableText}
        onTextPreview={(v) => {
          if (selectedEl && selectedEl.childElementCount === 0) {
            originalText(selectedEl)
            selectedEl.textContent = v
          }
        }}
        onTextCommit={(v) =>
          selected && patch(selected, { text: v, operation: "text" })
        }
        onStraighten={() => {
          const el = selected ? registry.current.get(selected) : undefined
          if (!selected || !el) return
          patch(selected, {
            rotation: round(-readBaked(el).rotation, 2),
            operation: "style",
          })
        }}
        onApplyAll={() => {
          if (!selected || !record) return
          commit({
            desktop: { ...drafts.desktop, [selected]: record },
            tablet: { ...drafts.tablet, [selected]: record },
            mobile: { ...drafts.mobile, [selected]: record },
          })
          say("Applied to all breakpoints")
        }}
        onResetSelected={() => {
          if (!selected) return
          const next = { ...drafts[bp] }
          delete next[selected]
          commit({ ...drafts, [bp]: next })
        }}
        onResetView={() => commit({ ...drafts, [bp]: {} as Draft })}
        onResetAll={() => commit(EMPTY_DRAFTS)}
        onCopy={async () => {
          await navigator.clipboard.writeText(exportJson())
          say("JSON copied")
        }}
        onDownload={() =>
          download(`${page}-layout.json`, exportJson(), "application/json")
        }
        onImport={() => fileInput.current?.click()}
        onCapture={() => {
          const container = root()
          if (!container) return
          const capture = captureBreakpoint(container, bp)
          setCaptures((c) => [...c.filter((x) => x.breakpoint !== bp), capture])
          say(`Captured ${bp}`)
        }}
        captured={captures.map((c) => c.breakpoint)}
        onSnapshot={() => {
          const container = root()
          if (!container) return
          const all = [
            ...captures.filter((c) => c.breakpoint !== bp),
            captureBreakpoint(container, bp),
          ]
          download(
            `${page}-design-reference.html`,
            buildSnapshot(drafts, all, page),
            "text/html"
          )
          say("Design reference downloaded")
        }}
      />

      <input
        ref={fileInput}
        type="file"
        accept="application/json"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          try {
            const parsed = JSON.parse(await file.text()) as {
              changes?: Array<EditRecord & { breakpoint: Breakpoint }>
            }
            const next: Drafts = { desktop: {}, tablet: {}, mobile: {} }
            for (const row of parsed.changes ?? []) {
              const { breakpoint, ...rec } = row
              next[breakpoint][rec.id] = rec
            }
            commit(next)
            say("Draft imported")
          } catch {
            say("That file isn't a layout export")
          }
          e.target.value = ""
        }}
      />

      {toast && <div className="le-toast">{toast}</div>}
    </div>
  )
}

/**
 * The copy field keeps its own value while you type.
 *
 * Driving it straight off the record would fight the typist: the preview
 * writes to the DOM but the record only moves on blur, so a controlled
 * textarea snapped back to the old string after every keystroke. It re-syncs
 * when the record changes underneath it — a different element selected, an
 * undo — which is the only time the outside should win.
 */
function TextField({
  value,
  onPreview,
  onCommit,
}: {
  value: string
  onPreview: (v: string) => void
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <textarea
      rows={3}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        onPreview(e.target.value)
      }}
      onBlur={() => onCommit(draft)}
    />
  )
}

/* ── Panel ─────────────────────────────────────────────────────────────── */

function Panel(props: {
  bp: Breakpoint
  mode: EditMode
  setMode: (m: EditMode) => void
  panelMode: PanelMode
  setPanelMode: (m: PanelMode) => void
  panelPos: { x: number; y: number }
  onPanelGrab: (e: React.PointerEvent) => void
  level: Level
  setLevel: (l: Level) => void
  meta: { id: string; component: string; parent: string; level: Level } | null
  count: number
  zoom: number
  setZoom: (z: number) => void
  record?: EditRecord
  showHits: boolean
  setShowHits: (v: boolean) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onClose: () => void
  onPatch: (changes: Partial<EditRecord>) => void
  onColor: (f: "color" | "background" | "border", v?: string) => void
  onStyleAll: (changes: Partial<EditRecord>) => void
  onRemove: () => void
  text?: string
  onTextPreview: (v: string) => void
  onTextCommit: (v: string) => void
  onStraighten: () => void
  onApplyAll: () => void
  onResetSelected: () => void
  onResetView: () => void
  onResetAll: () => void
  onCopy: () => void
  onDownload: () => void
  onImport: () => void
  onCapture: () => void
  captured: Breakpoint[]
  onSnapshot: () => void
}) {
  const r = props.record
  const float = props.panelMode === "float"
  const num = (label: string, field: keyof EditRecord, value?: number) => (
    <label className="le-field" key={field as string}>
      <span>{label}</span>
      <input
        type="number"
        value={value ?? ""}
        placeholder="—"
        onChange={(e) =>
          props.onPatch({
            [field]: e.target.value === "" ? undefined : round(+e.target.value),
          })
        }
      />
    </label>
  )

  return (
    <div
      className="le-panel"
      data-float={String(float)}
      style={
        float ? { left: props.panelPos.x, top: props.panelPos.y } : undefined
      }
    >
      <h2 onPointerDown={props.onPanelGrab} data-grab={String(float)}>
        <span>Edit layout · {props.bp}</span>
        <span className="le-headbtns">
          <button
            type="button"
            className="le-dockbtn"
            onClick={() => props.setPanelMode(float ? "dock" : "float")}
          >
            {float ? "Dock" : "Float"}
          </button>
          <button
            type="button"
            className="le-close"
            aria-label="Close editor"
            title="Close editor"
            onClick={props.onClose}
          >
            ✕
          </button>
        </span>
      </h2>

      <div className="le-section">
        <label>Mode</label>
        <div className="le-row">
          <button
            type="button"
            data-active={props.mode === "safe"}
            onClick={() => props.setMode("safe")}
          >
            Production safe
          </button>
          <button
            type="button"
            data-active={props.mode === "concept"}
            onClick={() => props.setMode("concept")}
          >
            Concept
          </button>
        </div>
        <p className="le-note">
          {props.mode === "safe"
            ? "Elements stay inside their own container."
            : "Moves across containers are recorded as proposals."}
        </p>
      </div>

      <div className="le-section">
        <label>Selection level</label>
        <div className="le-row">
          {LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              data-active={props.level === l}
              onClick={() => props.setLevel(l)}
            >
              {l}
            </button>
          ))}
          <button
            type="button"
            data-active={props.showHits}
            onClick={() => props.setShowHits(!props.showHits)}
          >
            Hit areas
          </button>
        </div>
      </div>

      <div className="le-section">
        <label>Selected</label>
        {props.count > 1 && (
          <p className="le-note" style={{ marginTop: 0 }}>
            {props.count} elements selected · moves, colour and hide apply to
            all of them
          </p>
        )}
        {props.meta ? (
          <p className="le-meta">
            <b>{props.meta.component}</b>
            <br />
            {props.meta.id}
            <br />
            in <b>{props.meta.parent}</b>
            {r?.classification === "structural-change" && (
              <>
                <br />
                <span className="le-tag">structural · needs a refactor</span>
              </>
            )}
          </p>
        ) : (
          <p className="le-meta">
            Click an element. Click again to widen, Alt-click to go deeper,
            Shift-click to add another.
          </p>
        )}
      </div>

      {props.meta && (
        <>
          <div className="le-section">
            <label>Position and size</label>
            <div className="le-grid">
              {num("X", "x", r?.x)}
              {num("Y", "y", r?.y)}
              {num("W", "w", r?.w)}
              {num("H", "h", r?.h)}
              {num("°", "rotation", r?.rotation)}
              {num("Z", "z", r?.z)}
            </div>
            <div className="le-row" style={{ marginTop: 6 }}>
              <button type="button" onClick={props.onStraighten}>
                Straighten 0°
              </button>
              <button
                type="button"
                onClick={() => props.onPatch({ hidden: !r?.hidden })}
              >
                {r?.hidden ? "Show" : "Hide"}
              </button>
              <button type="button" onClick={props.onRemove}>
                Delete
              </button>
            </div>
            <p className="le-note">
              Arrows nudge 1px, Shift+arrows 10px. Shift while resizing locks
              the ratio.
            </p>
          </div>

          {props.text !== undefined && (
            <div className="le-section">
              <label>Text</label>
              <TextField
                value={props.text}
                onPreview={props.onTextPreview}
                onCommit={props.onTextCommit}
              />
              <p className="le-note">
                Copy changes are recorded as an intent, like everything else —
                the string still has to go through the translation catalogue.
              </p>
            </div>
          )}

          <div className="le-section">
            <label>Alignment</label>
            <div className="le-row">
              {(["left", "center", "right"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  data-active={r?.align === a}
                  onClick={() =>
                    props.onStyleAll({ align: r?.align === a ? undefined : a })
                  }
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          <div className="le-section">
            <label>Type and spacing</label>
            <div className="le-grid">
              {num("Aa", "fontSize", r?.fontSize)}
              {num("W", "fontWeight", r?.fontWeight)}
              {num("P", "padding", r?.padding)}
              {num("G", "gap", r?.gap)}
            </div>
            <p className="le-note">
              Size and padding in px, weight 100–900. Gap only does anything on
              a flex or grid container.
            </p>
          </div>

          <div className="le-section">
            <label>Appearance</label>
            {(
              [
                ["Text", "color"],
                ["Fill", "background"],
                ["Border", "border"],
              ] as Array<
                ["Text" | "Fill" | "Border", "color" | "background" | "border"]
              >
            ).map(([label, field]) => (
              <div className="le-row" key={field} style={{ marginBottom: 6 }}>
                <span className="le-swatchlabel">{label}</span>
                <input
                  type="color"
                  value={(r?.[field] as string) || "#000000"}
                  onChange={(e) => props.onColor(field, e.target.value)}
                />
                <button type="button" onClick={() => props.onColor(field)}>
                  Clear
                </button>
              </div>
            ))}
          </div>

          <div className="le-section">
            <div className="le-row">
              <button type="button" onClick={props.onApplyAll}>
                Apply to all breakpoints
              </button>
              <button type="button" onClick={props.onResetSelected}>
                Reset selected
              </button>
            </div>
          </div>
        </>
      )}

      <div className="le-section">
        <label>Zoom</label>
        <div className="le-row">
          <button
            type="button"
            onClick={() =>
              props.setZoom(Math.max(0.25, +(props.zoom - 0.1).toFixed(2)))
            }
          >
            −
          </button>
          <span
            className="le-meta"
            style={{ minWidth: 42, textAlign: "center" }}
          >
            {Math.round(props.zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() =>
              props.setZoom(Math.min(2, +(props.zoom + 0.1).toFixed(2)))
            }
          >
            +
          </button>
          <button type="button" onClick={() => props.setZoom(1)}>
            100%
          </button>
        </div>
        <p className="le-note">
          Cmd +, Cmd −, Cmd 0. Zooms the page, not the panel.
        </p>
      </div>

      <div className="le-section">
        <label>History</label>
        <div className="le-row">
          <button
            type="button"
            disabled={!props.canUndo}
            onClick={props.onUndo}
          >
            Undo
          </button>
          <button
            type="button"
            disabled={!props.canRedo}
            onClick={props.onRedo}
          >
            Redo
          </button>
          <button type="button" onClick={props.onResetView}>
            Reset {props.bp}
          </button>
          <button type="button" onClick={props.onResetAll}>
            Reset all
          </button>
        </div>
      </div>

      <div className="le-section">
        <label>Export</label>
        <div className="le-row">
          <button type="button" onClick={props.onCopy}>
            Copy JSON
          </button>
          <button type="button" onClick={props.onDownload}>
            Download JSON
          </button>
          <button type="button" onClick={props.onImport}>
            Import JSON
          </button>
        </div>
      </div>

      <div className="le-section">
        <label>Design snapshot</label>
        <div className="le-row">
          <button type="button" onClick={props.onCapture}>
            Capture {props.bp}
          </button>
          <button type="button" onClick={props.onSnapshot}>
            Export design snapshot
          </button>
        </div>
        <p className="le-note">
          Captured:{" "}
          {props.captured.length > 0 ? props.captured.join(", ") : "—"}
        </p>
      </div>
    </div>
  )
}
