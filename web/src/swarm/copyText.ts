/**
 * copyText — reliable clipboard copy with textarea fallback.
 *
 * Returns true when the text was copied, false when it could not be.
 * On failure the text is selected in a hidden textarea so the user can
 * press Ctrl+C / Cmd+C manually.
 */
export async function copyText(text: string): Promise<boolean> {
  // Primary: modern Clipboard API
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to execCommand
    }
  }

  // Fallback: hidden textarea + execCommand
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
