# Psst backend

Realtime backend for the Psst app. It owns the WebSocket session API, holds both provider secrets,
streams microphone audio into ElevenLabs for real-time speech-to-text, runs the Psst reasoning
engine on committed utterances and returns a recap when the session ends.

```
Psst app (S24 Ultra)              server/                                  ElevenLabs
  mic ─▶ audio.frame ─▶ session API ─▶ STT session ─▶ partial/committed ─▶ transcript frames
                          │                                                     │
                          └── conversation state ─▶ Sarvam reasoning ◀──────────┘
                                                          │
                                                 NO_ACTION / PSST ─▶ cue frame
```

`ELEVENLABS_API_KEY` and `SARVAM_API_KEY` live here and nowhere else: they are never sent to the
app, never logged and never returned from an endpoint.

## Layout

```
src/
  index.js          HTTP + WebSocket server, /health, session routing, lifecycle
  env.js            Loads the shared repo-root .env (real env vars always win)
  protocol.js       Wire protocol (mirrors src/types/realtime.ts in the app)
  session.js        In-memory session state: transcript, cues, clock, audio diagnostics
  audio.js          PCM format helpers (sample rate -> provider audio format)
  transcription.js  audio -> STT -> transcript frames -> decide() -> cue frames
  elevenlabs.js     Realtime STT client. The only module that reads ELEVENLABS_API_KEY.
  sarvam.js         SarvamReasoningProvider. The only module that reads SARVAM_API_KEY.
  reasoning.js      NO_ACTION / PSST seam, provider selection, cue guard, recap builder
  cue.js            Cue suppression: duplicates, near-identical advice, rate limiting
  outcome.js        The two outcomes: NO_ACTION / PSST
scripts/
  smoke.js          Offline protocol test — no provider credit used
  provider-test.js  Real provider test: TTS -> STT -> transcript -> reasoning
```

## Run it

```bash
npm run server:install   # or: npm install
npm run server:dev       # or: npm start, npm run smoke, npm run server:providers
```

The backend reads the repository-root `../.env` automatically, so there is no need to duplicate
secrets. For a standalone deployment, `server/.env` or `PSST_ENV_FILE` are also honoured, and real
environment variables always take precedence over any file.

Endpoints:

- `GET /health` — status. Reports configuration as **booleans and model names only**, plus session
  counts. No key material, ever.
- `WS /sessions/:id/stream` — the session channel used by the app.

## Environment variables

| Variable | Secret? | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | no | Listen port (8787) and bind address (0.0.0.0). |
| `PSST_CLIENT_TOKEN` | access token | When set, clients must connect with `?token=…`. Not a substitute for real auth. |
| `ELEVENLABS_API_KEY` | **SERVER-SIDE SECRET** | Read by `src/elevenlabs.js` only. |
| `ELEVENLABS_STT_MODEL` | no | Realtime STT model (default `scribe_v2_realtime`). |
| `ELEVENLABS_STT_COMMIT_STRATEGY` | no | `vad` (default, commits on silence) or `manual`. |
| `ELEVENLABS_STT_LANGUAGE` | no | Optional ISO language hint to skip detection latency. |
| `ELEVENLABS_STT_NO_VERBATIM` | no | Strip filler words (default `true`). |
| `SARVAM_API_KEY` | **SERVER-SIDE SECRET** | Read by `src/sarvam.js` only. |
| `SARVAM_MODEL` | no | Reasoning model (default `sarvam-105b-conversations`). |
| `SARVAM_REASONING_EFFORT` | no | `low` (default, lowest cue latency), `medium`, `high`. |
| `SARVAM_TIMEOUT_MS` | no | Reasoning budget before falling back to `NO_ACTION` (default 8000). |
| `PSST_MIN_CUE_INTERVAL_MS` | no | Minimum gap between cues (default 12000). |
| `PSST_RECAP_TIMEOUT_MS` | no | Budget for the model-written recap (default 6000). |

Never expose either key to the client, never rename them to `EXPO_PUBLIC_*`, never log them and
never return them from an endpoint.

## Protocol

Client → backend:

```json
{ "t": "session.start", "goal": { "title": "…", "objective": "…", "notes": "…", "preset": "sales" }, "client": { "platform": "android", "appVersion": "1.0.0" } }
{ "t": "session.pause" }
{ "t": "session.resume" }
{ "t": "session.stop" }
{ "t": "audio.frame", "seq": 12, "pcm": "<base64 PCM16 mono>", "audio": { "sampleRate": 16000, "channels": 1, "encoding": "int16" }, "byteLength": 3200 }
```

Backend → client:

```json
{ "t": "status", "status": "listening" }
{ "t": "transcript.partial", "entry": { "id": "…", "speaker": "them", "text": "…", "isFinal": false, "at": 2340 } }
{ "t": "transcript.final",   "entry": { "id": "…", "speaker": "them", "text": "…", "isFinal": true,  "at": 2600 } }
{ "t": "psst",  "cue": { "id": "…", "observation": "…", "action": "…", "tone": "signal", "at": 3000 } }
{ "t": "notice", "level": "warning", "message": "…" }
{ "t": "recap", "recap": { "id": "…", "title": "…", "summary": "…", "keyPoints": [], "commitments": [], "missed": [], "nextActions": [], "cueCount": 0 } }
{ "t": "error", "message": "…" }
```

`notice` is non-fatal (the session keeps running and the user is told what degraded); `error` is
fatal. Both sides drop malformed or unknown frames rather than crashing a live conversation.

## Audio path

Microphone frames are forwarded **unchanged**: base64 PCM16 little-endian mono at the sample rate
the device delivered. The provider audio format is derived from that rate
(`16000 → pcm_16000`), so nothing is resampled or transcoded end to end. Frames arriving before the
STT session is attached, while paused, or with an unusable format are dropped and counted, never
buffered — the backend does not accumulate audio it is not transcribing.

## Reasoning rules

- **Partials are display-only.** They never reach the model.
- **Only committed utterances are evaluated**, and only if the gate agrees (word count, minimum
  gap, single in-flight call).
- **Silence is a feature.** `decide()` has exactly two outcomes; most moments produce `NO_ACTION`.
- **Suppression** drops duplicates, near-identical advice, low-confidence cues and anything inside
  the minimum interval.
- **Failure is `NO_ACTION`.** Missing key, timeout, HTTP error, invalid JSON or a malformed decision
  all degrade to silence. A recap is always produced from what was actually captured.

### ReasoningProvider

`decide()` and `buildRecap()` talk to a provider contract, never to Sarvam's response shape:

```js
provider.evaluate({ goal, transcript, latest, recentCues })
  // -> { outcome: 'NO_ACTION' } | { outcome: 'PSST', cue: { observation, suggestion, confidence } }

provider.summarize({ goal, transcript, cues, durationMs })
  // -> { summary, keyPoints, commitments, missed, nextActions } | null
```

Sarvam is configured with a strict JSON schema, and the decision is validated again on arrival:
`action` must be `PSST`, both fields must be non-empty, and confidence must clear a floor. Cues are
clamped to short, glanceable text — a model answering with a paragraph still yields one-line advice.

## Tests

```bash
npm run smoke       # offline: lifecycle, malformed frames, /health, recap. No provider credit.
npm run providers   # real calls. See below.
npm run providers -- --recap   # also exercise the model-written recap
```

`provider-test.js` is a genuine end-to-end check of the server-side pipeline:

1. **ElevenLabs TTS** synthesises the acceptance sentence as PCM16 16 kHz (this machine has no
   microphone).
2. **ElevenLabs STT** — the production client streams it to the real realtime endpoint and asserts
   real spoken words come back, with partials.
3. **Sarvam** — `decide()` runs on that transcript (expects `PSST` for the price objection),
   on a small-talk control (expects `NO_ACTION`) and on a repeated cue (expects suppression).

Recorded result: 9 passed, 0 failed — real transcript
*"We really like the product, but 2,000 dollars per month is above our budget."* and a real cue
*"Customer stated a budget ceiling." / "Ask for their target budget range."* (confidence 0.95).
Sarvam occasionally needs more than the 8 s live budget; the test widens its own budget and reports
latency, while the live path deliberately stays short and degrades to `NO_ACTION`.

## Design rules

- **Secrets stay server-side.** The app receives transcripts, cues and recaps only.
- **No database, no framework, no Kubernetes.** Sessions live in memory for the duration of a
  conversation; audio is never stored.
- **No fake output.** If transcription is unavailable the session stays silent and says so.

## Deploying on the Azure Ubuntu VM

TLS is required (`wss://`) because the app streams microphone audio.

```bash
# on the VM
sudo apt-get install -y nodejs npm
cd /opt/psst && sudo npm ci --omit=dev --prefix server

sudo tee /etc/systemd/system/psst-backend.service >/dev/null <<'UNIT'
[Unit]
Description=Psst realtime backend
After=network.target

[Service]
WorkingDirectory=/opt/psst/server
EnvironmentFile=/etc/psst-backend.env     # chmod 600: ELEVENLABS_API_KEY, SARVAM_API_KEY
ExecStart=/usr/bin/node src/index.js
Restart=always
User=psst

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl enable --now psst-backend
```

Put nginx or Caddy in front for TLS and proxy `/sessions/` with WebSocket upgrade headers. The app
only needs the public origin:

```bash
# app build-time env (EAS environment variable, not a secret)
EXPO_PUBLIC_PSST_BACKEND_URL=https://psst.example.com
EXPO_PUBLIC_PSST_BACKEND_TOKEN=the-same-shared-token     # only if PSST_CLIENT_TOKEN is set
```

## Still to do

1. Real access control: verify the caller's Psst Pro entitlement (RevenueCat webhook or REST API)
   instead of the shared `PSST_CLIENT_TOKEN`.
2. Retention policy and logging review for transcripts held in memory.
3. Speaker separation is not implemented: every line is labelled `them`.
