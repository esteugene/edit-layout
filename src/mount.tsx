"use client"

/**
 * The gate in front of EDIT LAYOUT.
 *
 * Two jobs. It keeps the editor out of environments that shouldn't have it —
 * the host app decides which, via `enabled`. And it loads the editor lazily
 * behind `?edit=1`, so even where it is allowed the code only arrives when
 * somebody asks for it.
 */

import dynamic from "next/dynamic"
import { useEffect, useState } from "react"
import type { StableIdMap } from "./core"

const LayoutEditor = dynamic(() => import("./layout-editor"), { ssr: false })

export function LayoutEditorMount({
  rootSelector,
  page,
  stableIds,
  enabled = true,
}: {
  rootSelector: string
  page: string
  stableIds?: StableIdMap
  /**
   * Whether this environment may load the editor at all. The host app decides
   * — it is the only side that knows what production means for it. Keep it
   * false on the real site: a design tool has no business in the bundle a
   * visitor downloads.
   */
  enabled?: boolean
}) {
  const [armed, setArmed] = useState(false)

  // Read after mount, not during render: the query string is a client-only
  // fact, and reading it while rendering would interfere with prerendering.
  useEffect(() => {
    if (!enabled) return
    setArmed(new URLSearchParams(window.location.search).has("edit"))
  }, [enabled])

  if (!armed) return null
  return (
    <LayoutEditor
      rootSelector={rootSelector}
      page={page}
      stableIds={stableIds}
    />
  )
}
