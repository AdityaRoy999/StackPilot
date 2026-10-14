# StackPilot — product launch film V2

48 seconds · English · 1920×1080 · 60 fps. The 1280×720 sharing export is also 60 fps. V1 exports are preserved in the working folder.

The user's brief: “ultra smoothness,” “high end motion graphic,” and “show the actual features of the app that matters.”

## Direction

One device: a sculptural stack opens into a set of optical interface planes. The real product stays central. Source, configuration, repair, logs, health, and a connected desktop become progressively closer camera targets. Dark studio lighting, restrained cyan, large Jakarta type, thin edges, real interface pixels. No generic orbiting spheres or fake performance statistics.

Considered directions: an abstract orb tour (discarded after V1 feedback); terminal-only film (too little interface); product planes with a tangible stack (selected). Signature moment: the recorded recovery result comes into focus and the repaired entrypoint resolves into a rebuild/HTTP-check callout.

Energy: high, controlled. Immediate typography, continuous camera life, 120 BPM original score, voice leading. Major transitions overlap for one second. Quintic camera curves have zero first and second derivatives at endpoints; critically damped springs handle type. Six subframe shutter samples during faster moves provide genuine temporal motion blur. Grain remains stable rather than changing every frame. Captions are composited after motion blur so they remain sharp.

| Time | Feature / image | Motion |
|---|---|---|
| 0–4 | Your code, ready for launch; generated glass/titanium stack | Staggered masked type, slow sculptural drift |
| 4–10 | StackPilot and its actual Projects interface | Optical push; interface plate rises into the foreground |
| 10–18 | GitHub/local/SSH import; branch and private environment review | Connected screen transition, gentle camera pan, control cue |
| 18–26 | AI repair with repository/branch/environment context | Camera moves into the actual chat interface; recorded repair callout |
| 26–34 | Real rebuild log, runtime health, browser-workflow evidence | Log-to-health transition; browser proof plane arrives in depth |
| 34–42 | Remote Connections form and actual connected RDP viewer | Form-to-connected-desktop reveal, subtle camera drift |
| 42–48 | Your stack, your control; repository CTA | Original sculpture returns, staggered lockup, held ending |

## Real interface and evidence

The frontend was captured at 1600×1000 with 2× pixels. All API responses for the capture were isolated demo fixtures; no real account or deployment was modified. The repair conversation is a faithful editorial reconstruction of the recorded successful qualification, not the original chat transcript. The repair/rebuild/HTTP 200 claims come from `tests/artifacts/github-real-healing.json` in the parent app. Only declared HTTP health checks are claimed. The browser workflow screenshot comes from the separately qualified sample ToDo application. It does not imply that the repaired calculator passed that ToDo workflow.

The connected desktop screenshot is the existing real XRDP-through-StackPilot qualification, including keyboard input. It is a Linux RDP test desktop; the film does not claim an available Windows worker or show a fabricated Windows session. Remote setup is a staged form with no saved password. Environment values and customer details are absent.

`public/product-v2/manifest.json` records capture provenance. `public/product-v2/evidence-v2.json` contains the minimal factual evidence used by the film.

## Re-render and preview

Install Node dependencies with `npm ci`. FFmpeg and Edge/Chromium must be available. Set `STACKPILOT_BROWSER_EXECUTABLE` for a different installed browser. The renderer uses an ephemeral loopback server and captures deterministic frames; it does not require the StackPilot server because all video assets are included.

```powershell
node tools/launch-render-v2.mjs stills
node tools/launch-render-v2.mjs render
python tools/verify-v2.py
```

Preview: `npm run studio` opens the editable Remotion V2 composition. For the Canvas/audio preview, serve this directory locally and open `preview-v2.html`. Remotion CLI may require a `chrome-headless-shell` binary via `--browser-executable`, or full Chrome with `--chrome-mode=chrome-for-testing`.

Motion and copy: `js/launch-v2.mjs`. Palette: `js/theme.mjs`. Render wrapper: `render-v2.html`. Remotion composition: `src/index-v2.tsx`. Captions: `public/captions.json`. English narration and original score from V1 are retained; the cached audio files are bundled. To regenerate audio from scratch, use `requirements.txt` and `audio/prepare.py` with a separate Python environment. Model weights remain outside the project.

The optional `tools/capture-product-v2.mjs` needs the parent StackPilot frontend and recorded qualification files. It is only for recapturing interface pixels; all images needed for a standalone render are already supplied.

## Generated supporting asset

`public/stack-studio-v2.png` was generated with the built-in image tool, with transparency, then copied intact into this project. No generated interface or text is used. The exact prompt is in `image-prompt-v2.md`. The image is animated procedurally; the film is not generated pixel video.

Technical verification: `out/qa-v2/verification.json`. Creative review: `REVIEW-V2.md`. Encoded frame inspection and cadence checks happen after rendering.
