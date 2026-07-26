export interface FuzzyMatch {
  score: number
  /** Indices in `text` that matched, for highlighting. */
  indices: number[]
}

const BONUS_PREFIX = 18
const BONUS_WORD_START = 10
const BONUS_CONSECUTIVE = 8
const PENALTY_GAP = 1

const WORD_BOUNDARY = /[\s\-_/.:]/

/** Greedy left-to-right match anchored at `start`. */
function matchFrom(q: string, t: string, start: number): FuzzyMatch | null {
  const indices: number[] = []
  let score = 0
  let cursor = start
  let lastMatch = -2

  for (let qi = 0; qi < q.length; qi++) {
    const char = q[qi]
    if (char === ' ') continue

    const found = t.indexOf(char, cursor)
    if (found === -1) return null

    if (found === 0) score += BONUS_PREFIX
    else if (WORD_BOUNDARY.test(t[found - 1])) score += BONUS_WORD_START

    if (found === lastMatch + 1) score += BONUS_CONSECUTIVE
    else score -= Math.min(found - cursor, 10) * PENALTY_GAP

    indices.push(found)
    lastMatch = found
    cursor = found + 1
  }

  return { score, indices }
}

/**
 * Subsequence matcher tuned for command palettes: rewards prefixes, word starts
 * and runs of adjacent characters, so "nag" ranks "New agent" above "Manage
 * settings". Returns null when `query` isn't a subsequence of `text`.
 *
 * A purely greedy pass anchors on the first occurrence of the first character,
 * which for "mat" against "Theme: Matrix" would latch onto the m in "Theme"
 * and both mis-highlight and under-score the real match. So we try every
 * possible anchor and keep the best — cheap at palette sizes.
 */
export function fuzzy(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (q.length === 0) return { score: 0, indices: [] }

  const t = text.toLowerCase()
  let best: FuzzyMatch | null = null

  for (let anchor = t.indexOf(q[0]); anchor !== -1; anchor = t.indexOf(q[0], anchor + 1)) {
    const match = matchFrom(q, t, anchor)
    if (match && (!best || match.score > best.score)) best = match
  }

  if (!best) return null

  // Shorter targets win ties: "New agent" over "New agent in a git worktree".
  return { score: best.score - text.length * 0.1, indices: best.indices }
}
