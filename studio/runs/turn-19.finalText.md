Reading the file first. Two targeted edits: strip `value` from `HOW_STEPS` and update the card render, then add `Questions` accordion before the closing `</div>` of the outer container. ```
oxlint: Found 0 warnings and 0 errors.
tsc --noEmit: exit 0
```

Two changes made:

**How it works cards:** `value` field removed from `HOW_STEPS`. The accent large-type line is gone. Each card now shows: step number (muted, xs), label as the heading (`text-base font-bold` in ink colour), body text. The footer row and CTAs are unchanged.

**Questions accordion:** Added below "How it works" inside the same `space-y-10` wrapper, so it gets the same spacing as the rest of the page. One large rounded container matching "How it works". All seven Q/A pairs from the spec, word for word. One-at-a-time open behaviour: `openIdx` state, clicking an open item closes it. Smooth expand via `max-height` CSS transition (0px to 400px at 0.22s). Chevron rotates 180° when open. Each button has `aria-expanded`, `aria-controls`, and matching `id`/`role="region"` on the panel. No icons added.