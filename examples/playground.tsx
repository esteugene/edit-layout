/**
 * A page built to be taken apart.
 *
 * One surface for each thing the editor claims to handle: a hero, a repeated
 * card (the case where one nudge should become a rule for all three), a row of
 * figures, a list of hairlines and 8px dots (the elements that are impossible
 * to click without an enlarged hit area), and a wide block for alignment and
 * padding. Nothing here is real content — it is a rig.
 *
 * Drop it into any React app, mount it at a route, and open that route with
 * `?edit=1`.
 */

import { LayoutEditorMount } from "../src/mount"
import "./playground.css"

const EDIT_IDS: Array<[selector: string, id: string]> = [
  [".pg-hero", "hero"],
  [".pg-hero h1", "hero-title"],
  [".pg-hero p", "hero-sub"],
  [".pg-cta-row", "cta-row"],
  [".pg-cta-primary", "cta-primary"],
  [".pg-cta-ghost", "cta-ghost"],
  [".pg-cards", "cards"],
  [".pg-card", "card"],
  [".pg-figures", "figures"],
  [".pg-figure", "figure"],
  [".pg-figure-value", "figure-value"],
  [".pg-figure-label", "figure-label"],
  [".pg-list", "list"],
  [".pg-list-row", "list-row"],
  [".pg-rule", "rule"],
  [".pg-dot", "dot"],
  [".pg-wide", "wide"],
]

const CARDS = [
  {
    title: "One surface per behaviour",
    body: "The sample includes containers, text, controls and small graphics so every editor mode has something to act on.",
  },
  {
    title: "Repeated structures",
    body: "Three matching cards make it easy to tell whether a one-off adjustment should become a shared layout rule.",
  },
  {
    title: "Portable by default",
    body: "The page uses plain React and CSS so it can be mounted without bringing along a product or design system.",
  },
]

const FIGURES = [
  { value: "3", label: "Cards" },
  { value: "4", label: "List rows" },
  { value: "8 px", label: "Smallest dot" },
]

const ROWS = [
  "Move a heading",
  "Resize a repeated card",
  "Restyle a small graphic",
  "Export the resulting changes",
]

export default function Playground() {
  return (
    <div className="pg" data-edit-root="">
      <div className="pg-inner">
        <section className="pg-hero">
          <p className="pg-kicker">Playground</p>
          <h1>A page with one of everything</h1>
          <p>
            Open the editor, pull this apart, and export what you did. Nothing
            here is real — it is a rig for judging the tool.
          </p>
          <div className="pg-cta-row">
            <span className="pg-cta-primary">Primary action</span>
            <span className="pg-cta-ghost">Secondary</span>
          </div>
        </section>

        <section className="pg-cards">
          {CARDS.map((card) => (
            <article key={card.title} className="pg-card">
              <h2>{card.title}</h2>
              <p>{card.body}</p>
            </article>
          ))}
        </section>

        <section className="pg-figures">
          {FIGURES.map((f) => (
            <div key={f.label} className="pg-figure">
              <div className="pg-figure-value">{f.value}</div>
              <div className="pg-figure-label">{f.label}</div>
            </div>
          ))}
        </section>

        <section className="pg-list">
          {ROWS.map((row, i) => (
            <div key={row}>
              {i > 0 && <div className="pg-rule" />}
              <div className="pg-list-row">
                <span className="pg-dot" />
                <span>{row}</span>
              </div>
            </div>
          ))}
        </section>

        <section className="pg-wide">
          <h2>A wide block, centred</h2>
          <p>
            Left, centre, right — somewhere to try the alignment controls, and
            wide enough that padding and gap do something visible.
          </p>
        </section>
      </div>

      <LayoutEditorMount
        rootSelector="[data-edit-root]"
        page="playground"
        stableIds={EDIT_IDS}
        enabled={process.env.NODE_ENV !== "production"}
      />
    </div>
  )
}
