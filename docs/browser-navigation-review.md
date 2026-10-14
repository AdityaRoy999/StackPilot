# Browser navigation and recovery review — 12 October 2026

The portfolio run examined in this review made 36 tool calls. Its route audit
visited only the starting URL, skipped repeated “View Case Study” controls,
and sent the contact form twice. A failed text/value assertion caused a retry
after the form had already reacted. A client-side response does not prove
message delivery to the server.

## Causes

- Duplicate buttons were identified by label without enough card context.
  This collapsed separate case studies into one ambiguous target.
- Detail views use the same URL and mount after an animation. URL equality
  and an immediate observation were insufficient to identify or restore them.
- “Back” mixed browser history with parent-view recovery, and there was no
  explicit forward operation. Some history checks ignored URL case or query
  details. Browser back/forward cache could also revive stale element IDs.
- The audit confused newly loaded inline preview controls with child views.
- Form assertions used guessed success text and expected values to remain
  after submission. Those checks failed when the UI changed to “Sent ✓” and
  cleared the fields. Retry protection depended on transient form state.

## Changes

Separate controls carry their nearest card heading. Navigation observes fresh
controls, explores bounded nested detail views and modal children, and verifies
the original parent controls before moving to another sibling. Animated views
receive a bounded wait. A replacement between observation reads triggers one
fresh read instead of being treated as an empty view. Inline previews remain
on their parent page.

Back and forward use exact browser history entries. Parent recovery separately
tries an observed harmless close control, the saved history entry, an observed
parent control, and finally a verified direct reload. Recovery respects the
authorized origin, native dialogs, selected frames and populated input drafts.
It reports an incomplete state when restoration cannot be proved. Recovered
documents receive fresh element references, including browser cache restores.

Generic site audits do not send forms. Explicit submission scenarios keep their
permission checks. A task records consequential inputs even if their response
is lost or cancelled; a changed button label, refilled form or failed assertion
cannot authorize replay. Enter and the default submit button share a dispatch
identity. Required-field validation that dispatches no input can still be fixed.

## Qualification

Isolated Chromium fixtures cover repeated cards, nested modals, delayed same-URL
detail views, exact back/forward history, navigation boundaries, stale-reference
refresh and submission replay prevention. They use local fixture forms only.

A separate anonymous navigation-only check on the portfolio site opened all
three case studies and restored the project list after each. It finished on
the starting page without filling or submitting forms. Focus-only clicks remain
unverified rather than being reported as successful business outcomes.

This is bounded navigation qualification. Downloads, external links, server
delivery, payment/account changes and undeclared business journeys need their
own scenarios and outcome checks. Laya remains deferred.

Verification completed in this change:

- Full browser regression run: 436 tests, successful, four skipped.
- Final navigation and site-audit checks after the last observation fix:
  41 tests, successful, including native Chromium fixtures.
- Project UI qualification at 375, 768, 1024 and 1440 pixels: successful.
  Covers creation confirmation, brand SVGs, expandable evidence, visible
  actions and unclipped ingress options. API responses are mocked.
- Production frontend build and TypeScript checks: successful.
- Lint: zero new violations; the existing 63-error baseline remains.

The full browser run is performed without concurrent live-browser suites.
Running several suites against the same worker produced timeout failures;
the isolated rerun passed. Verification logs and UI captures are in
`tests/artifacts/` (local, ignored by Git).
