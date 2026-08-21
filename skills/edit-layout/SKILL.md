---
name: edit-layout
description: >-
  Vendor the EDIT LAYOUT composition editor onto a page of the React app you
  are working in, so the page can be recomposed visually in the browser and handed
  back as JSON or a design snapshot. Use whenever someone wants to move things
  around on a real page by hand rather than in code — "прилепи эту штуку на
  страницу", "накинь редактор лейаута", "давай подвигаем блоки на этой
  странице", "поставь edit layout на /pricing", "attach the layout editor",
  "let me drag this around", "mount the composition editor here". Also use to
  take it back off ("убери редактор", "detach edit layout") and to turn a
  finished export into an implementation plan. Never build a new editor — this
  installs the existing one from github.com/esteugene/edit-layout.
---

# EDIT LAYOUT

An on-page composition editor that runs on top of a real React page. Select
what the page rendered, move / resize / recolour / rewrite / delete it, export
the result as data. It never touches the React tree — every change is a delta
keyed by a stable element id, previewed through CSS custom properties, so
closing it restores the page exactly.

Source of truth: `https://github.com/esteugene/edit-layout`. Read its
`README.md` — bundled at `$CLAUDE_PLUGIN_ROOT/README.md` when this arrived as a
plugin, otherwise in the checkout you clone below. It documents the props, the
export format and the traps. **Never write a replacement.**

Three modes, decided by what was asked:

- **ATTACH** (default) — install it and hand back a URL.
- **DETACH** — remove every trace when the review is over.
- **IMPLEMENT** — turn a returned export into changes.

---

## ATTACH

### 1. Find the page and its region

Ask for the route only if it is genuinely ambiguous. Otherwise resolve it
yourself:

- Locate the route file. In a Next App Router repo the region to mark is
  usually the `<main>` in the **nearest layout** that wraps that route — a
  route-group layout beats the root layout, because the editor should only be
  able to touch this surface.
- If the interesting screen is several steps into a flow (a quiz, a checkout, a
  wizard), say so when you hand over the URL and name the steps to walk.
- **Check which checkout actually holds the page.** Where the repo is used
  through git worktrees or sibling clones, a branch's page will not exist in
  the main checkout. `find <repo>/app -path '*<route>*'` across the candidates
  before assuming you are in the right one.

### 2. Install as a vendored copy

```bash
# A plugin install already carries the source. Otherwise fetch a checkout.
SRC="${CLAUDE_PLUGIN_ROOT:-/nonexistent}/src"
[ -d "$SRC" ] || { rm -rf /tmp/edit-layout &&
  git clone -q https://github.com/esteugene/edit-layout /tmp/edit-layout &&
  SRC=/tmp/edit-layout/src; }
mkdir -p components/dev/layout-editor
cp "$SRC"/* components/dev/layout-editor/
```

This is **a vendored copy for a review pass, not a dependency.** Dev-only, never
into production, deleted when the review ends. Do not add it to `package.json`.
Do not commit it to a branch that will be merged.

### 3. Pick the landmarks

Landmarks give short ids, so the export reads `hero-title` instead of a DOM
path. Page-specific by nature: what counts as a landmark on a pricing table is
nothing like what counts as one on a quiz.

Worth naming: the panel, the headline, the figure, the CTA, a repeated card,
the thing the reviewer will actually argue about. Everything else still gets a
generated id.

How to find them, in order of preference:

1. **Existing semantic class names** in the page's own components/CSS
   (`.result-amount`, `.quiz-option`). Grep the component files.
2. If the page is **Tailwind-only** and has no semantic classes, use structural
   or attribute selectors (`section:nth-of-type(2) h2`, `[data-testid=…]`), or
   ship a smaller map — a short honest map beats a long guessed one.

**Verify every selector resolves before wiring it.** A stale landmark is
invisible at runtime: the element just gets a generated id and nobody notices.

```bash
for c in result-amount quiz-option btn-primary; do
  printf '%-24s %s\n' "$c" "$(grep -rln -- "$c" --include='*.tsx' --include='*.css' app components | head -2 | tr '\n' ' ')"
done
```

Selectors that only exist on a later step of a flow are fine — count them as
found, and mention in the handover which screen they live on.

### 4. Wire it

```tsx
import { IS_DEV, IS_PRODUCTION } from "@/lib/env" // this repo's dev flags
import { LayoutEditorMount } from "@/components/dev/layout-editor/mount"

// TEMPORARY: delete this, the mount below and components/dev/layout-editor/
// when the review is done.
const EDIT_IDS: Array<[selector: string, id: string]> = [
  [".hero h1", "hero-title"],
]

<main className="flex-1" data-edit-root="">{children}</main>
<LayoutEditorMount
  rootSelector="[data-edit-root]"
  page="pricing"                      // namespaces the saved draft; one per page
  stableIds={EDIT_IDS}
  enabled={IS_DEV || !IS_PRODUCTION}
/>
```

`LayoutEditorMount` is a client component, so a `async` server layout can render
it directly. Leave a `TEMPORARY:` comment on the map so the cleanup is obvious
to anyone who opens the file.

### 5. The environment gate — the one thing to get right

A design tool has no business in the bundle a real visitor downloads.

**Check the dev flag FIRST.** In a Next app on Vercel a local checkout can
carry `VERCEL_ENV=production` from `vercel env pull`, and the config may forward
it to the client — so a plain `!isProduction` gate closes on the one machine
that most needs the editor open. Where the app exposes both flags, write
`enabled={IS_DEV || !IS_PRODUCTION}`. Find the equivalent dev flag in this repo
before writing the gate, rather than assuming `NODE_ENV` is enough.

### 6. Run and verify — never hand over an unverified URL

Start the dev server the way this environment expects — through the harness's
preview/dev-server mechanism rather than a raw backgrounded Bash process, so it
is visible and can be stopped. A worktree usually needs its own entry, on its
own port.

Then confirm all four, in the browser:

1. `?edit=1` → the **EDIT LAYOUT** launcher renders bottom right.
2. Clicking it opens the docked panel (screenshot it).
3. **Without** `?edit=1` → zero edit buttons, zero editor nodes in the DOM.
4. `eslint` clean on the vendored folder and the touched layout; no console
   errors, no server errors.

`navigate` to a URL differing only in query string may not re-navigate — set
`location.href` from `javascript_tool` instead, then re-read `location.href` to
confirm you are actually on the page you think you are.

### 7. Hand over

Give the **full origin URL with `?edit=1`**, and name the preview server as it
appears in the dropdown. Say the real port if autoPort moved it. Then add:

- which steps to walk if the interesting screen is deep in a flow;
- which landmarks only appear on later screens;
- **the page stops responding to clicks while the editor is on** — that is
  deliberate, a click has to mean "select" not "submit"; close it to advance.

Ask for **Copy JSON** (or **Export design snapshot** for a designer) when done.

---

## Traps

- **Do not add `data-edit-id` attributes to components.** Ids are stamped at
  runtime from `stableIds`. Most components render on other surfaces too, where
  this editor never runs, and they should not carry attributes that exist for a
  dev tool.
- **Ids are stamped lazily.** `document.querySelectorAll('[data-edit-id]')`
  returning 0 right after opening the panel is not a bug.
- **Design-system lints.** The editor's chrome deliberately uses its own
  palette, so a house-palette lint may flag the vendored files depending on
  what it scans. Run the repo's lints once after vendoring rather than guessing,
  and if it complains, add that repo's file-level suppression to the vendored
  copy — it is deleted at detach, so the suppression never outlives the review.
  Demo content you add is not covered either; in particular, never put a
  currency figure in throwaway content.
- **`STORAGE_VERSION` in `core.ts`** must be bumped once an export is
  implemented, or an old localStorage draft stacks its deltas on the new
  baseline. That failure is invisible: the page still looks edited and you go
  hunting for a bug that lives in localStorage.
- Breakpoints keep separate drafts. Desktop edits do not silently rewrite
  mobile.

---

## DETACH

```bash
rm -rf components/dev/layout-editor
```

Then revert the layout: the import, the `EDIT_IDS` map, the `data-edit-root`
attribute and the `<LayoutEditorMount>`. Confirm with `git status` /
`git diff` that **nothing** from the tool survives, and that no unrelated
change was reverted with it. Nothing from this should reach a merged branch.

## IMPLEMENT

Read the export's own guidance in the cloned `README.md` ("Implementing an
approved export"), and follow it: round the accidental fractions, look for the
pattern before the instance, map `css-safe` rows onto spacing / grid / props /
tokens, reorder through JSX or `order` rather than absolute positioning, and
treat `structural-change` rows as a refactor to be specced rather than forced.
