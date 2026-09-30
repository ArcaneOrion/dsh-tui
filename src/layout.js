/** Small terminal layout primitives. All widths are display cells, including CJK. */
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

export function fit(text, width) {
  return truncateToWidth(String(text ?? ''), Math.max(0, width), '')
}

export function pair(left, right, width) {
  width = Math.max(0, width)
  if (visibleWidth(left) + visibleWidth(right) + 2 > width) return fit(left, width)
  return left + ' '.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right))) + right
}

export function rule(label, width, theme) {
  const prefix = `─ ${label} `
  return theme.fg('border', fit(prefix + '─'.repeat(Math.max(0, width - visibleWidth(prefix))), width))
}

/** A vertical margin ties metadata to content without surrounding every message in a box. */
export function rail(component, theme, { tone = 'border', label, trailing } = {}) {
  return {
    invalidate() { component.invalidate?.() },
    render(width) {
      const inner = Math.max(1, width - 4)
      const lines = []
      if (label) lines.push(fit(' ' + pair(label, trailing ?? '', Math.max(0, width - 2)), width))
      for (const line of component.render(inner)) {
        lines.push(fit(' ' + theme.fg(tone, '│') + ' ' + line, width))
      }
      return lines
    },
  }
}
