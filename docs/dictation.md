# Dictation

The chat microphone writes live text into the prompt. It does not create voice
attachments or require the browser vendor's speech service. During capture the
control displays a red listening orb; its accessible name remains “Stop dictation.”
No listening toast or visible status label is shown.

AudioWorklet captures mono PCM. The authenticated backend binds every speech
request to the current account and forwards bounded chunks to the internal speech
service. Partial results replace the current dictated text; stop flushes pending
audio and waits for the final words before Send reads the prompt. Retried chunks
use sequence acknowledgements to avoid repeating words. Cancel, manual prompt
edits, chat changes, and unmount stop microphone tracks and dispose of the decoder.

The bundled [Vosk English model](https://alphacephei.com/vosk/models) is
`vosk-model-small-en-us-0.15`, licensed under Apache 2.0. Its build download has a
pinned SHA-256. Model loading is shared and warmed in the background; microphone
audio, decoder state, and transcripts remain ephemeral in memory. Decoder work
runs outside the AI service's event loop. No audio file or attachment is saved.
The first shipped language is English; recognition quality varies by speech and
microphone conditions.

Sessions allow at most five minutes, two active captures per account, and four
active decoders per service. Idle sessions expire after 30 seconds. Short-lived
final acknowledgements support stop retries. The PCM endpoint has its own bounded
rate bucket (`STACKPILOT_DICTATION_RATE_LIMIT_PER_MINUTE`, default 960), preserving
the general API allowance during streaming. Microphone access requires HTTPS or
localhost and browser permission.

Qualification uses synthesized PCM speech, checks partial results before stop,
final recognition, owner binding, cross-user denial, sequence retry behavior,
resource limits, and browser capture on desktop and mobile. UI fixtures do not
start model calls or mutate user projects/deployments.
