# Mobile chat and Remote layout — October 4, 2026

The populated Remote screen was using intrinsic grid widths. At a 320px viewport its cards reached 487.7px, putting disconnect controls and activity statuses off-screen. Explicit zero-minimum grid tracks, bounded cards/inputs, wrapping activity rows and device names now keep the same fixture cards within 304px. Pairing QR codes and confirmation actions fit at the narrowest tested width.

Phone chat uses full-width assistant content without the desktop avatar gutter or outer response card. User messages keep compact rounded bubbles. Thinking and tools start collapsed on phones. Expanded browser batches show action names and counts instead of object coercion; expanded text preserves line breaks without dumping frame/image payloads. Report table cells wrap to keep all four example columns visible.

The phone composer has one action row: +, model, voice and send/stop. The + dialog provides attachments, commands and project/website selection. A selected target appears above the input. Commands, project selection, model selection and attachment requests preserve the draft. Desktop controls and the existing same-message permission continuation remain available.

Validation on production image eb7e694bb1db29ddd4f15c59f2f46e6c6add1696ba6cf163eed64eb40f4f9270:

- Next production build and TypeScript passed.
- 19 targeted unit tests passed, including structured argument summaries, image-payload omission, continuation, Markdown and browser zoom/input mapping.
- 24 isolated production-preview layout cases passed: Remote and chat at 320, 375, 390, 430, 768 and 1280px, both light and dark. Fixtures include a long HTTPS hostname, approved/pending devices, activity, browser tool batches and a report table. No off-screen controls or runtime exceptions were observed.
- Deployed localhost frontend health returned HTTP 200.
- Deployed chat regression passed retained scroll position, permission inside assistant, same bubble after approval, one dispatch, neutral permission styling and saved Markdown.
- Deployed phone regression passed pairing, full-platform sidebar access, approval and question recovery.

These are emulated viewport and intercepted API checks, not physical-phone or streaming-FPS measurements. No real pairing, model request, deployment or device change was made by qualification. Only the frontend was recreated; the temporary preview container was removed.

Artifacts: mobile-chat-remote-qualification-2026-10-04.json, mobile-chat-remote-before-2026-10-04.json, mobile-chat-redesign-continuation-2026-10-04.json, mobile-chat-redesign-phone-2026-10-04.json, and the light/dark chat, options and Remote screenshots.
