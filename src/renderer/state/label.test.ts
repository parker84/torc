import { describe, expect, it } from 'vitest'
import { paneLabel } from './label'

describe('paneLabel', () => {
  it('prefers the ai-title over the folder name', () => {
    expect(paneLabel({ title: 'torc 2', aiTitle: 'Fixing the wheel sensitivity' })).toBe(
      'Fixing the wheel sensitivity',
    )
  })

  it('falls back to the pane title before there is one', () => {
    expect(paneLabel({ title: 'torc 2' })).toBe('torc 2')
  })

  it('lets a name the user typed win over the ai-title', () => {
    // Otherwise a rename un-does itself as soon as the agent titles a new turn.
    expect(paneLabel({ title: 'infra', aiTitle: 'Fixing the wheel', renamed: true })).toBe('infra')
  })
})
