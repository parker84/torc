import { describe, expect, it } from 'vitest'
import { isAutoTitle, titleFor, uniqueTitle } from './paneTitle'

describe('titleFor', () => {
  it('names a pane after its folder', () => {
    expect(titleFor('/Users/b/Documents/side/torc')).toBe('torc')
    expect(titleFor('/Users/b/Documents/side/torc/')).toBe('torc')
  })

  it('always returns something, even at the root', () => {
    expect(titleFor('/')).toBe('session')
    expect(titleFor('')).toBe('session')
  })
})

describe('isAutoTitle', () => {
  const cwd = '/Users/b/Documents/side/trace-backend'

  it('recognises the derived name and its numbered repeats', () => {
    expect(isAutoTitle('trace-backend', cwd)).toBe(true)
    expect(isAutoTitle('trace-backend 2', cwd)).toBe(true)
    expect(isAutoTitle('trace-backend 17', cwd)).toBe(true)
  })

  it('leaves a name the user chose alone', () => {
    expect(isAutoTitle('api work', cwd)).toBe(false)
    expect(isAutoTitle('trace-backend rewrite', cwd)).toBe(false)
    // Not a repeat counter, so someone typed it.
    expect(isAutoTitle('trace-backend v2', cwd)).toBe(false)
  })
})

describe('uniqueTitle', () => {
  it('leaves a free name as it is', () => {
    expect(uniqueTitle('torc', ['opendata'])).toBe('torc')
  })

  it('numbers repeats from 2, filling the first gap', () => {
    expect(uniqueTitle('torc', ['torc'])).toBe('torc 2')
    expect(uniqueTitle('torc', ['torc', 'torc 2'])).toBe('torc 3')
    expect(uniqueTitle('torc', ['torc', 'torc 3'])).toBe('torc 2')
  })
})
