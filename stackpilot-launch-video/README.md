# StackPilot — From repository to release

An original 48-second, 1920×1080, 60 fps launch film with English Kokoro narration, stable-ts word alignment, kinetic type, and a voice-reactive circular motif. Deterministic Canvas scenes also run in Remotion.

## Direction card

Film in one line: a repository becomes a controlled release, guided by one circular AI motif.
Read from: user's request for the Sarvam launch style, supplied screenshots, repository README and verified qualification reports. Reference video fetch was throttled; the user's written breakdown supplied the direction.
Concept: **One signal, one cockpit** (23/25). The circular AI badge travels through type, pipeline, repair and real interface crops. Signature: it becomes the release signal and finally the StackPilot mark.
Other concepts: terminal-only launch (19/25, less product visibility); full UI camera tour (18/25, too dense for the requested style).
Look: Terminal release blended with an uncluttered product film; the supplied dark StackPilot interface sets the palette. Circular accents change between cyan, violet and warm amber, one hero at a time.
Energy: high from the opening, based on the user's “fast text reveals” reference; sustained syncopated rhythm, with a 0.2-second hole before the brand reveal. Voice leads, with ducked music.
Type: the app's Plus Jakarta Sans (hero 110–170px) and JetBrains Mono (support 28–38px).
Banned: invented stats, universal-build claims, customer data, scene counters, HUD decorations, stock footage, borrowed music, Sarvam marks/voices/words.

| Time | Picture | Motion | Sound |
|---|---|---|---|
| 0–4 | Your code. Ready for launch. | Masked words, traveling rule, rotating orb | Immediate syncopated groove; voice starts at 0.5 |
| 4–10 | StackPilot / Application delivery cockpit | Orb contracts into wordmark space; springs | Three-note sonic logo on 4.0 |
| 10–18 | Repository → environment → release | Staggered graph; type resolves to Build / Verify / Deploy | Key clicks and shared beat cues |
| 18–26 | Inspect / Repair / Retry | Orb moves left; context chips stagger in | Spoken agent workflow; violet visual response |
| 26–34 | Runtime / logs / browser checks | Actual qualified GUI crop; sweeping signal | Groove gains upper pluck layer |
| 34–42 | Remote desktops inside StackPilot | Actual settings crop moves into focus | UI taps and remote-access narration |
| 42–48 | Your stack. Your control. / StackPilot | Circle settles into brand lockup; CTA holds | Sonic logo, last phrase, 1.4-second fade |

Sound brief: original 120 BPM syncopated electro in D minor, clean plucks, restrained sub, shuffled hats, keyboard/tap transients, three-note D–F–A sonic logo. Narration leads; music ducks under speech. Target −14 LUFS and ≤−1 dBTP after AAC encoding. No stock samples.

## Re-render

Python audio environment: requirements.txt pins Kokoro, stable-ts and matching Torch/torchaudio versions. Use a separate Python environment, install those requirements, then npm install for the renderer. FFmpeg and Chromium/Edge are required. On other computers, install Playwright's Chromium with npx playwright install chromium, or set STACKPILOT_BROWSER_EXECUTABLE. Model files remain in the external cache and are checksum verified. For CPU PyTorch, use the official CPU wheel index for the matching torch and torchaudio packages.

```powershell
python audio/prepare.py all
node tools/launch-render.mjs stills
node tools/launch-render.mjs render
```

For an editable Remotion preview: npm run studio. The same timeline, Canvas drawing function, caption JSON and soundtrack drive both previews. Text: js/copy.mjs. Palette: js/theme.mjs. Motion: js/launch.mjs. Speech: audio/prepare.py.

## Sessions

2026-10-14: English selected. Applied the two community skills plus official Remotion/caption guidance. The built-in animate skill was unavailable; spring and choreography implemented directly. The platform was not changed.

Final exports and encoded frame inspection passed. Master: 22.87 MB, −14.51 LUFS, −1.42 dBTP; sharing copy: 3.83 MB, −14.52 LUFS, −1.36 dBTP. Exact frame counts and complete decode verified. Review notes are in REVIEW.md; machine evidence is in out/qa/verification.json. Master and sharing MP4s include burned-in word highlights; out/stackpilot-launch-en.srt provides separate captions for upload.
