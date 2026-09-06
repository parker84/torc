import { describe, expect, it } from 'vitest'
import { wheelLines } from './wheel'

describe('wheelLines', () => {
  it('preserves sub-row trackpad movement', () => {
    expect(wheelLines(3, 0, 18, 40, false)).toBeCloseTo(1 / 6)
  })

  it('preserves direction without carrying state across reversals', () => {
    expect(wheelLines(-3, 0, 18, 40, false)).toBeCloseTo(-1 / 6)
    expect(wheelLines(3, 0, 18, 40, false)).toBeCloseTo(1 / 6)
  })

  it('normalises line and page wheel events', () => {
    expect(wheelLines(2, 1, 18, 40, false)).toBe(2)
    expect(wheelLines(-1, 2, 18, 40, false)).toBe(-40)
  })

  it('uses xterm-compatible Option fast scrolling', () => {
    expect(wheelLines(2, 1, 18, 40, true)).toBe(10)
  })
})
