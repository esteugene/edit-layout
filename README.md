# EDIT LAYOUT

A composition editor that runs on top of a real React page.

Select anything the page rendered, move it, resize it, recolour it, rewrite its
copy — then export what you did as JSON or as a static design reference. It
never touches the React tree: every change is a delta keyed by a stable element
id, previewed through CSS custom properties. Close the editor and the page is
byte-for-byte what it was.

It exists for the gap between "here's a screenshot with a red arrow on it" and
"here's a branch". A designer or a PM can recompose a live page with real data
in it, and hand back something an engineer can actually implement.

## What it is not

It does not write React. It cannot: it only ever sees the DOM the components
produced, not the components. The export is an **intent**, and the last step —
turning it into CSS, props, tokens, or a refactor — is a human's.

## Install

### With Claude Code (recommended)

Two lines, once per machine. This repo is its own plugin marketplace:

```
/plugin marketplace add esteugene/edit-layout
/plugin install edit-layout@esteugene
```

Then open the page you want to recompose and say **`/edit-layout`** — or just
"attach the layout editor to /pricing". It finds the route, picks the
landmarks, wires the mount behind a dev-only gate, starts the dev server,
checks the gate actually closes, and hands you back a URL. `/edit-layout
detach` takes it all off again.

Without the plugin system, the skill alone — one line, needs `gh` logged in:

```
gh repo clone esteugene/edit-layout /tmp/edit-layout && bash /tmp/edit-layout/install.sh
```

It writes a single file, `~/.claude/skills/edit-layout/SKILL.md`, and
`--uninstall` removes it again.

While this repo is private, both routes go through your GitHub credentials —
`/plugin marketplace add` and `gh repo clone` each work for anyone with read
access, and neither needs anything else set up. If it is ever made public, the
same installer also works unauthenticated:

```
curl -fsSL https://raw.githubusercontent.com/esteugene/edit-layout/main/install.sh | bash
```

### By hand

No package, no dependencies beyond React. Copy this folder into your app:

```
cp -r src your-app/components/edit-layout
```

The only host-specific wiring is a boolean you pass in. Nothing here imports
from your app. The rest of this README is what to do next; the skill above just
automates it.

## Mount it on a page

Three things: mark the region the editor may touch, mount the gate, and decide
where it is allowed to run.

```tsx
import { LayoutEditorMount } from "@/components/edit-layout/mount"

// Landmarks get short ids, so the export reads `hero-title` instead of a DOM
// path. Optional — without it ids are derived from the tree. Page-specific by
// nature: what counts as a landmark on a dashboard is nothing like what counts
// as one on an article page.
const EDIT_IDS: Array<[selector: string, id: string]> = [
  [".hero h1", "hero-title"],
  [".feature-card", "feature-card"],
]

export default function Layout({ children }) {
  return (
    <>
      <main data-edit-root="">{children}</main>
      <LayoutEditorMount
        rootSelector="[data-edit-root]"
        page="sample-page"
        stableIds={EDIT_IDS}
        enabled={process.env.NODE_ENV !== "production"}
      />
    </>
  )
}
```

`enabled` is yours to decide, and it matters: a design tool has no business in
the bundle a real visitor downloads. Even when enabled, the editor only loads
behind `?edit=1`, so the code arrives when somebody asks for it.

`page` namespaces the saved draft. Two pages, two drafts.

Then open the page with `?edit=1` and click **EDIT LAYOUT**, bottom right.

## Try it first

`examples/playground.tsx` is a page built to be taken apart — a hero, a
repeated card, a row of figures, a list of hairlines and 8px dots, a wide
block. Mount it at a route in any React app and open that route with `?edit=1`.
It is plain CSS on purpose: an example that needed a design system to render
would be an example of the design system.

## Using it

**Selecting.** Three levels — `frames` (containers), `inner` (text, labels,
buttons), `graphics` (icons, rules, dots). A click takes the deepest element at
that level; click again to widen outwards; Alt-click ignores the level and goes
deeper; Shift-click adds another element to the selection. Hairlines and small
dots get an enlarged invisible hit area, because a 3px rule is otherwise a coin
toss to hit.

**Moving.** Press and pull. Arrows nudge 1px, Shift+arrows 10px, and both act on
the whole selection. Handles resize the primary element; Shift locks the ratio.
`Straighten 0°` cancels an element's own rotation rather than pretending it had
none.

**Two modes.** _Production safe_ keeps every element inside the container that
lays it out. _Concept_ lets a move cross a component boundary and records it as
`reparent` / `structural-change` — a proposal, not a change; the React tree is
never modified either way.

**Removing.** `Delete` (or the Delete key) takes an element out of the flow, so
the layout closes up around it — the question a reviewer is usually asking.
`Hide` keeps the space instead. Undo or `Reset selected` brings it back.

**Type and spacing.** Alignment, font size and weight, padding and gap. Like
colour, these apply to the whole selection.

**Copy.** Editable on leaf nodes only. Writing `textContent` into a node with
element children would silently delete them, and a tool that eats a button is
worse than one that admits it can't edit that node.

**Zoom.** Cmd +, Cmd −, Cmd 0. Zooms the edited region, not the panel.

**Panel.** Docked by default: the body gives up that width, so the column sits
beside the page instead of over it. `Float` lifts it off as a draggable overlay.

**History.** Undo/redo with the usual keys. One gesture is one entry, however
many elements it moved. `Reset selected` / `Reset <breakpoint>` / `Reset all`.

**Breakpoints.** Desktop, tablet and mobile keep separate drafts. Editing one
never silently rewrites another; `Apply to all breakpoints` does it on purpose.

## Getting the work out

**Copy / Download JSON** — one row per change: breakpoint, element id, React
component name where the dev build exposed it, original container, intended
destination, geometry, colours, copy, and whether it is `css-safe` or
`structural-change`.

```json
{
  "breakpoint": "desktop",
  "id": "hero-title",
  "component": "Hero",
  "from": "hero-grid",
  "x": 0,
  "y": -12,
  "operation": "move",
  "classification": "css-safe"
}
```

**Export design snapshot** — a self-contained HTML file: the composition per
captured breakpoint, the change tables split into CSS-safe and structural, and
notes for whoever implements it. Stamped `DESIGN REFERENCE — NOT PRODUCTION
CODE`, because that is what it is.

## Implementing an approved export

1. Round the accidental fractions. Pointer maths produces 0.7333px; nobody
   meant that.
2. Look for the pattern before the instance. One card nudged usually means the
   grid's gap is wrong, not that one card needs a transform.
3. CSS-safe rows become spacing, Grid/Flex placement, props or tokens on the
   existing component.
4. Reordering goes through JSX or data order, Grid areas, or Flex `order` — not
   absolute positioning that imitates the screenshot.
5. Structural rows are a refactor. If one can't be mapped back safely, ship the
   snapshot and a written spec instead of forcing it.
6. Bump `STORAGE_VERSION` in `core.ts` once it's implemented, so an old local
   draft can't stack its deltas on top of the new baseline. That failure is
   invisible otherwise: the page still looks edited and you go hunting for a
   bug that lives in localStorage.

## Traps worth knowing

- **The preview needs `!important`.** Animation libraries write `transform` as
  an inline style, and an inline declaration outranks a normal stylesheet rule.
  It is scoped to elements the editor actually touched, so everything else keeps
  animating as it did.
- **Baseline and delta stay separate** (`--baked-*` vs `--edit-*`). Collapsing
  them loses the element's original rotation, and `Straighten` then has nothing
  to cancel.
- **Your dev server may believe it is production.** If your framework forwards
  a deployment env var to the client, a naive `!isProduction` gate closes on the
  one machine that most needs the editor open. Check your dev flag first.
- **Canvas.** Resizing a canvas through CSS stretches the bitmap, which is what
  turns circles into eggs, and CSS `color` does nothing to pixels. The editor
  therefore asks the renderer to redraw, via a `layout-editor:canvas` event
  carrying CSS size, device pixel ratio and colours. This path is a hook, not a
  claim — it has not been exercised against a real canvas renderer.

## Licence

MIT. See `LICENSE`.
