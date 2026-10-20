# Read-only browser text evidence

`browser_observe` with a bounded `query` returns `text_evidence` separately from actionable controls. Plain text leaves, semantic headings (`h1`–`h6`, `[role="heading"]`), `output`, and text blocks (`p`, `li`, `td`, `th`, `dt`, `dd`, `blockquote`, `figcaption`) receive real DOM references with `read_only: true` and `supported_actions: ["assert"]`. Semantic records also expose `semantic_role`. Their IDs never enter the interactive-control list or target-rebinding cache.

Headings and paragraphs often contain inline code, emphasis, icons, and links. Their visible text is assembled from safe text nodes rather than dropping the entire block because it has children. Whitespace between inline children is preserved; adjacent fragments are not given invented spaces. A matching fresh projection is used when asserting text against a semantic reference. Assertion expectations, exact/contains matching, and case sensitivity remain unchanged.

After a failed text assertion, bounded recovery evidence can supply fresh candidate references from at most two queries. It never changes the original target or expectation, marks the failed check as passed, or dispatches input. Native input names use the same accessible-label helper as observation; asserting an input's displayed text gives actionable feedback to use `accessible_name` for labels or `value`/`checked` for state.

Neither evidence nor semantic assertion text reads input values, editor contents, hidden/inert/aria-hidden descendants, or text beneath display/visibility/opacity-hidden ancestors. Context uses the same safe nodes. Observation registers IDs in internal browser maps without setting DOM attributes, dispatching events, or creating clickable candidates. Headings inside an actionable ancestor remain excluded from this evidence channel.

Observation keeps the existing 16,000-node scan bound, viewport/overlay scope, pagination, and bounded context. Semantic evidence aggregates at most 4,000 source characters and returns at most 400 text characters, explicitly marking truncation. A fresh semantic assertion scans at most 16,000 text nodes and 32,000 characters; exceeding either bound returns unavailable evidence, never a truncated pass. Document/frame changes, generation mismatches, and detached references do not supply valid assertions.

The local Chromium fixture exercises actual observation and assertion JavaScript, including inline markup, hidden content, stale references, strict case, and mutation/click counters:

```powershell
$env:PYTHONPATH = 'ai-service'
$env:AI_BROWSER_DOM_TESTS = '1'
# Optional: PLAYWRIGHT_MODULE points to an installed Playwright module;
# AI_BROWSER_EXECUTABLE selects an installed Chromium/Edge executable.
python -m unittest ai-service/tests/test_browser_text_evidence.py -v
```

Without `AI_BROWSER_DOM_TESTS=1`, the ordinary Python contract tests run and the local browser fixture is skipped.
