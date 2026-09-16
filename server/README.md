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
  env.js            Loads server/.env then the repo-root .env (real env vars always win)
  limits.js         Every server-side ceiling, env-overridable, reported by /health
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
test/
  *.test.js         Offline regression suite (node:test), fake STT endpoint
  support/          Test harness: fake provider, spawned backend, protocol client
```

## Run it

```bash
npm run server:install   # or: npm install
npm run server:dev       # or: npm start, npm run smoke, npm run server:providers
```

The backend reads `server/.env` first and then falls back to the repository-root `../.env`;
`PSST_ENV_FILE` overrides both, and real environment variables always take precedence over any file.

Server-side provider keys belong in **`server/.env`** (git-ignored, mode 600). The repository-root
`.env` exists for the app's `EXPO_PUBLIC_*` values — the Expo CLI loads and exports that file, so
keeping `ELEVENLABS_API_KEY` / `SARVAM_API_KEY` out of it removes any chance of them reaching the
bundle or a build log.

Endpoints:

- `GET /health` — status. Reports configuration as **booleans, model names and numbers only**, plus
  session counts, drop/throttle counters and the effective limits. No key material, ever.
- `WS /sessions/:id/stream` — the session channel used by the app.

## Environment variables

| Variable | Secret? | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | no | Listen port (8787) and bind address (0.0.0.0). |
| `PSST_CLIENT_TOKEN` | access token | When set, clients must connect with `?token=…`. Not a substitute for real auth. |
| `ELEVENLABS_API_KEY` | **SERVER-SIDE SECRET** | Read by `src/elevenlabs.js` only. |
| `ELEVENLABS_STT_ENDPOINT` | no | Realtime STT endpoint (default `wss://api.elevenlabs.io/…`). Also how the tests point the client at a local fake. |
| `ELEVENLABS_STT_MODEL` | no | Realtime STT model (default `scribe_v2_realtime`). |
| `ELEVENLABS_STT_COMMIT_STRATEGY` | no | `vad` (default, commits on silence) or `manual`. Anything else falls back to `vad` and is reported by `/health`. |
| `ELEVENLABS_STT_LANGUAGE` | no | Optional ISO 639-1/639-3 hint, sent as the `language_code` query parameter to skip detection latency. |
| `PSST_STT_OPEN_TIMEOUT_MS` | no | Provider handshake budget before the stream is declared dead (default 10000). |
| `PSST_STT_FLUSH_TIMEOUT_MS` | no | How long finalization waits for the commit it asked for (default 2500). |
| `ELEVENLABS_STT_NO_VERBATIM` | no | Strip filler words (default `true`). |
| `SARVAM_API_KEY` | **SERVER-SIDE SECRET** | Read by `src/sarvam.js` only. |
| `SARVAM_MODEL` | no | Reasoning model (default `sarvam-105b-conversations`). |
| `SARVAM_REASONING_EFFORT` | no | `low` (default, lowest cue latency), `medium`, `high`. |
| `SARVAM_TIMEOUT_MS` | no | Reasoning budget before falling back to `NO_ACTION` (default 8000). |
| `PSST_MIN_CUE_INTERVAL_MS` | no | Minimum gap between cues (default 12000). |
| `PSST_RECAP_TIMEOUT_MS` | no | Budget for the model-written recap (default 10000, below the app's 12 s wait). |

Limits (all optional; `/health` reports the effective values):

| Variable | Default | Bounds |
| --- | --- | --- |
| `PSST_MAX_PAYLOAD_BYTES` | 262144 | one WebSocket message |
| `PSST_MAX_AUDIO_FRAME_BYTES` | 65536 | decoded PCM per `audio.frame` |
| `PSST_MAX_SESSION_AUDIO_BYTES` | 100663296 | total audio accepted for one session (96 MiB) |
| `PSST_MAX_PROVIDER_QUEUE_BYTES` | 524288 | audio waiting for the provider socket |
| `PSST_PROVIDER_QUEUE_MAX_AGE_MS` | 4000 | age of that queued audio |
| `PSST_MAX_PROVIDER_BUFFERED_BYTES` | 524288 | unsent bytes on the provider socket before live audio is dropped |
| `PSST_MAX_SESSIONS` | 64 | concurrent live sessions (further upgrades get `503`; a duplicate live id gets `409`) |
| `PSST_IDLE_TIMEOUT_MS` | 180000 | silence before a session is ended with an explanation |
| `PSST_MAX_SESSION_DURATION_MS` | 3600000 | hard ceiling on one session |
| `PSST_MAX_MESSAGES_PER_SEC` | 300 | audio frames per second (control frames are never throttled) |

Set `PSST_MAX_PROVIDER_QUEUE_BYTES` above `PSST_MAX_AUDIO_FRAME_BYTES` (base64 is ~4/3 of the payload),
or a single frame will not fit in the pre-open queue and everything will be dropped.

The two session ceilings bound different things and either can be the one you hit:

| Ceiling | Default | Reached after |
| --- | --- | --- |
| `PSST_MAX_SESSION_AUDIO_BYTES` | 96 MiB | ~17½ min of continuous 48 kHz mono PCM16 (~52 min at 16 kHz) |
| `PSST_MAX_SESSION_DURATION_MS` | 60 min | 60 min of wall-clock session time |

Whichever comes first ends the session **visibly**: one `notice` frame explains which ceiling was
reached, the provider is flushed, and the recap is still delivered (`/health` counts these as
`audioBudgetEnds` and `durationLimitEnds`). Audio frames sent after the ceiling are dropped without a
second explanation. If you raise `PSST_MAX_SESSION_AUDIO_BYTES`, raise
`PSST_MAX_SESSION_DURATION_MS` with it — otherwise the byte budget and the duration budget tell
different stories about how long a session can last.

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

Session ids are supplied by the client in the URL. Two live connections may never share one: the
second upgrade for an id that is already streaming is refused with `409 Conflict` instead of silently
replacing the first session (the concurrency cap answers `503`). A connection only ever removes its
own registration when it closes.

A session slot is reserved before the handshake completes and released again if the handshake never
does: an invalid `Sec-WebSocket-Key` (HTTP 400), a socket that dies mid-upgrade, or an upgrade
exception all free the reservation immediately. Leaking one would permanently consume part of the
concurrency budget, so a refused handshake can never cost a real client a slot. Cleanup is idempotent
and identity-checked: a closing connection only ever deletes its own registration.

Parsing is total by construction: numeric fields (`seq`, `byteLength`, `audio.sampleRate`) are
treated as numbers or numeric strings and nothing else. JSON such as
`{"toString":null,"valueOf":null}` is valid input for `Number()`, which throws on it, so it is
refused rather than converted.

## Audio path

Microphone frames are forwarded **unchanged**: base64 PCM16 little-endian mono at the sample rate
the device delivered. The provider audio format is derived from that rate
(`16000 → pcm_16000`), so nothing is resampled or transcoded end to end. Frames arriving before the
STT session is attached, while paused, or with an unusable format are dropped and counted, never
buffered — the backend does not accumulate audio it is not transcribing.

A rate outside the endpoint's `AudioFormatEnum` (`pcm_8000`, `16000`, `22050`, `24000`, `44100`,
`48000`) is **rejected** and explained to the app, never relabelled as a nearby rate. The frame's
`byteLength` is verified against the decoded payload, so a frame that lies about its size is dropped
rather than half-trusted.

### Finalization (stop)

When a session stops, the session object stops accepting audio immediately and the app is told the
session is over **before** any finalization work starts (`status: ended`). That ordering is what stops
microphone capture at the client at once: the provider flush and recap generation can take seconds,
and an audio-budget or duration end must not leave the microphone running through them. The connection
stays open — the app waits on it for the recap.

After that announcement the provider is asked to commit with the endpoint's documented flush —
`input_audio_chunk` with an empty `audio_base_64` and `commit: true` — and the resulting
`committed_transcript` is given a bounded window (`PSST_STT_FLUSH_TIMEOUT_MS`) to arrive before the
provider socket closes. That final utterance is recorded and appears in the recap; it is deliberately
not reasoned about, because the user already ended the session. The physical microphone is off by
then: nothing is synthesised or kept open to force a commit.

### Commit strategy

`vad` (default) lets ElevenLabs decide where an utterance ends, which is what produces live cues.
`manual` disables that, so the only commits are the ones this server asks for: on **pause** and on
**stop**. Manual mode therefore yields no cues during continuous speech — it is documented and
implemented rather than silently ignored, and an unrecognised value falls back to `vad` with
`elevenlabsCommitStrategyRejected: true` in `/health`.

## Reasoning rules

- **Partials are display-only.** They never reach the model.
- **Only committed utterances are evaluated**, and only if the gate agrees (word count, minimum
  gap, single in-flight call).
- **Silence is a feature.** `decide()` has exactly two outcomes; most moments produce `NO_ACTION`.
- **Suppression** drops duplicates, near-identical advice, low-confidence cues and anything inside
  the minimum interval.
- **Pause is a boundary.** Pausing invalidates in-flight reasoning and clears queued work, so a cue
  about speech from before the pause can never surface after the user resumes. Nothing is reasoned
  about while paused, but the transcript is still recorded for the recap.
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
npm test            # offline regression suite (node:test). No provider credit, no microphone.
npm run smoke       # offline: lifecycle, malformed frames, /health, recap. No provider credit.
npm run providers   # real calls. See below.
npm run providers -- --recap   # also exercise the model-written recap
```

`npm test` runs `test/*.test.js` against a local fake STT endpoint — the same production code path,
with no provider involved. It covers the malformed frame that used to take the process down, numeric
metadata carrying an object (`{"toString":null,"valueOf":null}`) that `Number()` throws on, the
sample rate arriving at the provider unchanged (16 k/44.1 k/48 k through the real wire), survival of a
disconnect during STT connection setup, final-utterance preservation through a stop, the pause
boundary invalidating in-flight reasoning, pending-final coalescing, stale-cue rejection, duplicate
and over-limit session ids with their cleanup, refused and abandoned handshakes releasing their
reservation without eating the concurrency budget, concurrent admission inside the cap, the audio
budget and duration endings announcing the end immediately (with the flush and recap deliberately
delayed by the fakes) and still delivering exactly one honest recap, bounded audio buffering, and
every limit above. From the repository root, `npm test` also runs the app-side transport tests in
`test/client/`.

`provider-test.js` is a genuine end-to-end check of the server-side pipeline:

1. **ElevenLabs TTS** synthesises the acceptance sentence as PCM16 16 kHz (this machine has no
   microphone).
2. **ElevenLabs STT** — the production client streams it to the real realtime endpoint and asserts
   real spoken words come back, with partials.
3. **Sarvam** — `decide()` runs on that transcript (expects `PSST` for the price objection),
   on a small-talk control (expects `NO_ACTION`) and on a repeated cue (expects suppression).

Recorded result: **10 passed, 0 failed** — real transcript
*"We really like the product, but 2,000 dollars per month is above our budget."*, real cues such as
*"They stated their budget ceiling." / "Ask what their target range is."* and a real model-written
recap. Reasoning latency is stable at roughly **2.8 s** across repeated runs.

Two field findings are baked into `sarvam.js` and worth keeping in mind:

- The model intermittently emits a **raw newline inside a JSON string**, which is invalid JSON even
  though the structure is correct. `parseModelJson()` escapes in-string control characters instead
  of discarding an otherwise usable cue.
- It also ignored "max 10 words" until the prompt carried worked examples. With examples the cues
  became glanceable *and* ~2.5× faster, because short answers are cheap answers. Both cue fields are
  still clamped hard, so a chatty answer can never reach the screen as a paragraph.

## Design rules

- **Secrets stay server-side.** The app receives transcripts, cues and recaps only.
- **No database, no framework, no Kubernetes.** Sessions live in memory for the duration of a
  conversation; audio is never stored.
- **No fake output.** If transcription is unavailable the session stays silent and says so.
- **Total parsing.** The protocol layer runs on raw client input inside the WebSocket message
  handler, so it returns a result for every input instead of throwing; a bad frame is dropped, and an
  actionable one (an unsupported sample rate, an oversized frame) is explained once.
- **Bounded by default.** Every dimension a client could grow — frame size, session audio, provider
  queue bytes and age, concurrent sessions, idle time, session duration, frame rate — has a ceiling.

## Deploying on the Azure Ubuntu VM

### Prerequisites

| Requirement | Why |
| --- | --- |
| **Node.js 22 or newer** | `package.json` declares `engines.node >= 22`; the code uses `process.loadEnvFile`, `AbortSignal.timeout` and the built-in `node:test` runner. `apt-get install nodejs npm` on older Ubuntu images gives an old Node — install 22 from NodeSource (or nvm) first. |
| **A service user** | The unit below runs as `psst`. Create it, or change `User=` to an account that exists. |
| **A deployment directory** | `/opt/psst` is the assumed checkout. The service user must own the code so it can read it, and must not need to write to it. |
| **A DNS name + certificate** | The app only opens a TLS backend. Terminate TLS with nginx or Caddy (Caddy issues and renews Let's Encrypt certificates automatically). |
| **WebSocket upgrade proxying** | `/sessions/…` must pass `Upgrade`/`Connection` headers through, or sessions fail at the handshake. |

### Service setup

```bash
# on the VM — Node 22 from NodeSource, then a dedicated service user
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo useradd --system --home /opt/psst --shell /usr/sbin/nologin psst || true

sudo mkdir -p /opt/psst && sudo chown -R psst:psst /opt/psst
# place the repository at /opt/psst (git clone, rsync, …), then:
sudo -u psst npm ci --omit=dev --prefix /opt/psst/server
```

Secrets live in a root-owned file the service can read, never in the unit itself:

```bash
sudo install -m 600 -o root -g psst /dev/null /etc/psst-backend.env
sudo tee /etc/psst-backend.env >/dev/null <<'ENV'
ELEVENLABS_API_KEY=replace-me
SARVAM_API_KEY=replace-me
# Optional: shared token. Public value, not authentication — see “Still to do”.
# PSST_CLIENT_TOKEN=replace-me
ENV

sudo tee /etc/systemd/system/psst-backend.service >/dev/null <<'UNIT'
[Unit]
Description=Psst realtime backend
After=network.target

[Service]
User=psst
Group=psst
WorkingDirectory=/opt/psst/server
# One directive per line: systemd does not support trailing '# comments'.
EnvironmentFile=/etc/psst-backend.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now psst-backend
sudo journalctl -u psst-backend -n 50 --no-pager   # expect the limits line and 'configured' providers
```

The backend reads its secrets **only** from the real environment and the loaded file; real environment
variables always win (`src/env.js`), so a leftover development `.env` in the checkout cannot override
the production `EnvironmentFile`.

### TLS

nginx needs the upgrade headers on the session path; Caddy does it by default:

```caddy
psst.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Verify from outside: `curl -s https://psst.example.com/health | jq`.

The app only needs the public origin, as a build-time EAS environment variable (public, not a secret):

```bash
EXPO_PUBLIC_PSST_BACKEND_URL=https://psst.example.com
EXPO_PUBLIC_PSST_BACKEND_TOKEN=the-same-shared-token     # only if PSST_CLIENT_TOKEN is set
```

## Still to do

0. **Public-release gate — real access control.** `PSST_CLIENT_TOKEN` is a shared token that ships
   inside the app bundle, so it is a throttle, not authentication. Before this backend faces the
   public, it needs verified identity (RevenueCat webhook or REST API), per-user rate limiting and
   a retention decision for transcripts. Until then, keep it restricted to testers.
1. Real access control: verify the caller's Psst Pro entitlement (RevenueCat webhook or REST API)
   instead of the shared `PSST_CLIENT_TOKEN`.
2. Retention policy and logging review for transcripts held in memory.
3. Speaker separation is not implemented: every line is labelled `them`.
