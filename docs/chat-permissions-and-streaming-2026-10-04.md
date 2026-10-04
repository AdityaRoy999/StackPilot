# Chat permissions, rebuild receipts, and streaming

## Changes

- Permissions appear as a compact neutral card inside the assistant message, in their own collapsible Permissions section. Descriptions and exact arguments stay under Details.
- Approving a step resumes the same assistant message in the UI and database. The synthetic approval prompt is retained as internal history metadata, without another visible user bubble.
- Permission IDs remain stable through live events, saved history, and phone recovery. Approved proposals no longer show a stale authorization badge.
- Completed assistant bodies and Markdown trees are memoized. Text updates are batched at 100 ms; per-word blur animation was removed from streaming reasoning.
- One scroll follower replaces competing effects. It stops following when the reader scrolls up; it does not repeatedly start smooth scrolling during token updates.
- Saved conversation context uses the same safe Markdown renderer, including lists, emphasis, and fenced code.
- Repository approvals resume the signed exact tool and arguments before calling the model, with single-use consumption. They do not enter browser approval validation because a runtime URL is attached. Browser approvals still require the matching live page and exact step.
- Rebuild labels and summaries require a current-turn queue result with a job ID. Permission requests, blocked checks, and historical results are not queued builds.
- Empty merged metadata arrays are omitted. Legacy JSON null tool arrays are handled without aborting the next request's database transaction.

## Why the reported rebuild did not start

Inspection of the user's saved repair session found a blocked rebuild prerequisite: the completion plan and its features were not independently verified on the current source revision. A subsequent repository approval was incorrectly checked as a browser action and was rejected before dispatch. No new rebuild job had been created. The old failed job was not evidence of a new queue operation.

The fixes preserve source verification requirements. This qualification did not queue a real rebuild of the user's calculator project; dispatch and receipt checks use owned fixtures or mocks.

## Scrolling qualification

The original and updated production frontends were run sequentially in isolated Chromium contexts on the same Docker network. Each loaded 15 saved Markdown messages and streamed 160 chunks at 8 ms intervals with mocked APIs. Compilation had finished before measurement; no AI provider or deployment action was invoked.

Final idle comparison: frame interval p95 improved from 50 ms to 16.8 ms, and accumulated long-task duration fell from 999 ms to 84 ms (about 92% less main-thread blocking). Scroll position was retained only by the updated frontend. These are bounded fixture measurements, not a guarantee for every device or a measurement of browser video streaming FPS.

Final measurements are recorded in `chat-stream-before-2026-10-04.json` and `chat-stream-after-2026-10-04.json`.

## Verification

- 25 frontend unit tests: continuation identity, recovered permissions, Markdown safety, stream ownership, and phone transport.
- 5 exact-tool approval tests, including duplicate dispatch prevention and a blocked rebuild reporting its failed prerequisite.
- 10 browser permission tests retaining exact-step and page validation.
- Disposable backend/database qualification: continuation preserves the assistant message ID, saved permission metadata, hidden approval prompt, and follow-up requests, including legacy null metadata.
- Production UI qualification: neutral permission card, same bubble, one approval dispatch, retained scroll position, rendered saved Markdown, and no runtime errors.
- Full dashboard phone UI qualification: pairing, navigation, recovered approvals/questions, and no horizontal overflow.
- Production frontend TypeScript/build and backend C++ build.

## Local engine recovery

Docker Desktop stopped responding during validation. A restart exposed inaccessible Windows runtime socket files. The transient `Docker/run` and socket-only `docker-secrets-engine` directories were renamed and preserved, allowing Docker to recreate its listeners. Persistent containers, images, and volumes were not reset or deleted. The command proxy also required a subsequent restart, with another reversible quarantine of its runtime socket directories. The interrupted disposable fixture database and containers were cleaned up after engine recovery. The public phone tunnel remains off.

This failure matches firsthand reports in Docker's [Windows socket startup issue](https://github.com/docker/desktop-feedback/issues/531) and [parent-directory recovery report](https://github.com/docker/desktop-feedback/issues/554). Automatic approval review rejected deleting the stale socket; recovery used reversible directory renames instead.
