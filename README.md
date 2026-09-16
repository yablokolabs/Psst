# Psst

**Know what to say next.**

Psst is a real-time AI conversation copilot for live conversations. You start a session
explicitly, keep your phone nearby, and Psst listens through the device microphone, follows the
conversation and shows extremely short private suggestions when something important happens.

Psst is for negotiations, sales calls, customer conversations, business meetings, speakerphone
calls, online meetings running on another device, face-to-face discussions, difficult
conversations and multilingual communication.

Psst is **not** an interview assistant, exam assistant, assessment assistant, cheating tool,
covert recorder or surveillance application. It never captures cellular-call audio and it never
listens outside a session you started.

---

## Status

Phase 2b: the real microphone → realtime transcription → reasoning → cue pipeline is implemented.

| Piece | Status |
| --- | --- |
| App shell, PREP → LIVE → RECAP, RevenueCat | implemented, verified by lint/typecheck/doctor/bundle |
| Microphone capture (PCM, 16 kHz mono) | implemented — **not yet run on a physical device** |
| App → backend audio streaming | implemented — **not yet run from a phone** |
| ElevenLabs realtime STT | implemented and **tested server-side** with synthesised speech |
| Sarvam cue reasoning (`NO_ACTION` / `PSST`) | implemented and **tested server-side** against the live API |
| Cue suppression, honest recap fallback | implemented and tested server-side |
| Stop/interruption, sample-rate and provider-flush handling | implemented; covered by offline regression tests (`npm test`) |
| On-device test on a Galaxy S24 Ultra | **not yet performed** |

Where a claim has not been verified on a device, this README says so. See
[Verification](#verification) for exactly what was and was not run.

---

## Core experience: PREP → LIVE → RECAP

**PREP** — You tell Psst what the conversation is about and what you want to accomplish
(conversation title, objective, things not to forget, a preset such as Negotiation, Sales,
Customer, Meeting, Difficult conversation or Other) and choose the engine: **Live audio** or
**Demo**.

**LIVE** — Psst listens, follows the conversation and only surfaces something when it is genuinely
useful. Most moments produce `NO_ACTION`; useful ones produce a `PSST` cue:

```
Psst...
Price may not be the real blocker.
→ Ask what budget range they expected.
```

**RECAP** — When you end the session Psst summarises what happened: SUMMARY, KEY POINTS,
COMMITMENTS, THINGS YOU MAY HAVE MISSED and NEXT ACTIONS, with native share support.

Silence is a feature: the reasoning engine has exactly two outcomes, `NO_ACTION` or `PSST`.

---

## Architecture

One repository, two deployables: the Expo app at the root and the Node backend in `server/`.

```
Psst/
  src/                    Expo app (SDK 57, TypeScript, Expo Router)
  server/                 Psst backend (Node ESM + ws). Holds both provider secrets.
  app.json  package.json  .env        (git-ignored)  .env.example
```

Pipeline:

```
Samsung S24 Ultra microphone
        ↓  PCM16 mono, base64 frames over WSS
Psst Expo app                      EXPO_PUBLIC_REVENUECAT_API_KEY → RevenueCat SDK
        ↓  audio.frame
Psst backend (server/)             ELEVENLABS_API_KEY + SARVAM_API_KEY live here only
        ↓  PCM forwarded unchanged
ElevenLabs realtime STT (Scribe Realtime v2)
        ↓  partial + committed transcripts
conversation state → Sarvam reasoning → NO_ACTION / PSST
        ↓  psst frame
existing LIVE screen
```

Provider responsibilities are separate: **RevenueCat** monetises, **ElevenLabs** transcribes,
**Sarvam** reasons. The backend orchestrates, holds state, enforces cue suppression and builds the
recap. No provider key is ever sent to the app.

### App layout

```
src/
  app/                     Expo Router routes (file-based, stack navigation)
    _layout.tsx            Root stack + providers (Pro, session history)
    index.tsx              Home: hero, Start a Psst, recent conversations
    prep.tsx               PREP: preset, engine, title, objective, notes, privacy note
    live.tsx               LIVE: listening indicator, mic state, timer, transcript, cues
    recap.tsx              RECAP: summary sections, share, New Psst
    settings.tsx           Privacy, plan, connections, about
    pro.tsx                Psst Pro entry point / RevenueCat paywall
  components/              Reusable presentational components
  constants/               theme, plans, presets, audio capture format
  hooks/
    useConversation.ts     Drives LIVE from a ConversationService (no socket code in the UI)
    use-audio-capture.ts   Microphone → PCM frames (expo-audio native stream)
    use-pro.tsx            Pro entitlement context (RevenueCat)
    use-session-history.tsx In-memory recap history context
  services/
    conversation.ts             Engine interface, factory, env-driven default
    mockConversation.ts         MockConversationService (scripted demo)
    realtimeConversation.ts     RealtimeConversationService (WSS transport + audio frames)
    mockScenarios.ts            Scripted demo conversations + recaps
    mockHistory.ts              Seeded demo recaps for Home
    revenuecat.ts               RevenueCat abstraction (lazy, fail-soft)
    backend.ts                  Backend URL/token helpers (public values, no secrets)
  types/
    conversation.ts             Domain + event types (the engine contract)
    realtime.ts                 Wire protocol shared with the backend
  utils/                        formatting helpers, base64 for audio frames
```

`useConversation` consumes only `ConversationService`, so the LIVE screen contains no transport,
no microphone and no provider code.

### Engine contract

```ts
type ConversationEvent =
  | { type: 'STATUS'; status: ConversationStatus }
  | { type: 'TRANSCRIPT_PARTIAL'; entry: TranscriptEntry }
  | { type: 'TRANSCRIPT_FINAL'; entry: TranscriptEntry }
  | { type: 'PSST'; cue: PsstCue }
  | { type: 'NOTICE'; level: 'info' | 'warning'; message: string }   // non-fatal
  | { type: 'ERROR'; message: string };                              // fatal
```

`pushAudio(frame)` is the only microphone-facing method, and only the realtime engine implements
it. Nothing in the UI knows which engine is running beyond a label.

### Choosing an engine

`src/services/conversation.ts` resolves the default:

1. `EXPO_PUBLIC_PSST_MODE` wins when set to `realtime`/`live` or `mock`/`demo`.
2. Otherwise: a configured `EXPO_PUBLIC_PSST_BACKEND_URL` means `realtime`, and without one the
   honest default is `mock`.

The user can always override it per session on PREP, and the LIVE screen always states which
engine is running (`REALTIME AUDIO` / `SIMULATED AUDIO`) plus the microphone state.

**Realtime never silently falls back to the demo transcript.** If the backend or a provider fails,
LIVE shows the failure with *Try again* and *Use demo* actions; switching to the demo engine is an
explicit user choice.

The demo engine is kept on purpose: screenshots, the Devpost recording backup, development,
provider outages and testing without a microphone.

---

## Microphone and audio format

Capture uses `expo-audio`'s native **`AudioStream`** (SDK 57), which delivers real-time PCM buffers
instead of a recording file — Psst streams audio while it is spoken; it never uploads a finished
recording.

| Property | Value | Why |
| --- | --- | --- |
| Encoding | PCM16 little-endian | the format the realtime STT endpoint accepts (`pcm_16000`) |
| Sample rate | 16 000 Hz requested | standard speech rate; no resampling needed |
| Channels | 1 (mono) | realtime STT is a mono feed |
| Chunking | every buffer the device delivers, capped at 32 KB per frame | low latency, no artificial buffering |
| Transport | base64 inside JSON `audio.frame` frames over WSS | reliability and simplicity |

If a device delivers a different rate (44.1/48 kHz), that rate is forwarded **unchanged** and the
backend selects the matching provider format — there is no transcoding anywhere in the pipeline,
and no audio is ever written to disk. A rate the provider does not accept (anything outside
`pcm_8000/16000/22050/24000/44100/48000`) is **rejected with an explanation** rather than relabelled
as a nearby rate, because mislabelled audio would transcribe a pitch-shifted conversation.

The microphone is opened only while `status === 'listening'`: paused, connecting and ended sessions
send nothing. Tapping **End** leaves `listening` immediately — before any recap work — so capture and
outgoing audio stop at once while the recap is still being fetched. Capture is also closed
explicitly whenever the app leaves the foreground (Home, app switcher, lock screen);
`enableBackgroundRecording: false` alone does not stop an in-flight `AudioStream`.

### Development build required

`expo-audio`'s audio stream and RevenueCat both need native code, so the realtime experience
requires a **development or release build** — not Expo Go. The demo engine runs anywhere.

---

## Wire protocol (`src/types/realtime.ts` ↔ `server/src/protocol.js`)

App → backend:

```json
{ "t": "session.start", "goal": { "title": "…", "objective": "…", "notes": "…", "preset": "sales" }, "client": { "platform": "android", "appVersion": "1.0.0" } }
{ "t": "session.pause" }
{ "t": "session.resume" }
{ "t": "session.stop" }
{ "t": "audio.frame", "seq": 12, "pcm": "<base64 PCM16 mono>", "audio": { "sampleRate": 16000, "channels": 1, "encoding": "int16" }, "byteLength": 3200 }
```

Backend → app:

```json
{ "t": "status", "status": "listening" }
{ "t": "transcript.partial", "entry": { "id": "…", "speaker": "them", "text": "…", "isFinal": false, "at": 2340 } }
{ "t": "transcript.final",   "entry": { "id": "…", "speaker": "them", "text": "…", "isFinal": true,  "at": 2600 } }
{ "t": "psst",  "cue": { "id": "…", "observation": "…", "action": "…", "tone": "signal", "at": 3000 } }
{ "t": "notice", "level": "warning", "message": "…" }
{ "t": "recap", "recap": { "id": "…", "title": "…", "summary": "…", "keyPoints": [], "commitments": [], "missed": [], "nextActions": [], "cueCount": 0 } }
{ "t": "error", "message": "…" }
```

Malformed or unknown frames are dropped on **both** sides rather than crashing a live conversation,
and a malformed `audio.frame` is rejected without ending the server process. Audio metadata is
validated against the decoded bytes (a frame that declares a size it does not have is refused), and
the backend caps payload size, per-frame audio, total session audio, provider queue bytes and age,
concurrent sessions, idle time, session duration and audio-frame rate.

---

## Local development

```bash
npm install                 # app
npm run server:install      # backend (server/)

npm start                   # Expo dev server
npm run android             # open on a connected Android device/emulator
npm run server:dev          # backend with --watch
```

Useful root commands:

| Command | What it does |
| --- | --- |
| `npm run server:dev` | run the backend with reload |
| `npm run server:start` | run the backend once |
| `npm run server:smoke` | offline protocol smoke test — no provider credit used |
| `npm test` | offline regression suite: backend units + app transport (`npm run test:server`, `npm run test:client`) |
| `npm run server:providers` | **real** provider test: ElevenLabs STT + Sarvam reasoning |
| `npm run server:providers -- --recap` | the same test **including** the model-written recap |

Checks:

```bash
npm run lint       # expo lint
npx tsc --noEmit   # TypeScript
npx expo-doctor    # project health checks
npx expo export --platform android   # production bundle
```

`expo-env.d.ts`, `.expo/types`, `dist/`, `node_modules/` and every `.env` variant (`.env`,
`.env.local`, `.env.production`, …) are git-ignored. `git ls-files` contains no environment file
except the two `.env.example` templates.

---

## Environment variables

One `.env` at the repository root is shared by the app and the backend. `server/src/env.js` loads it
automatically, and **real environment variables always win**, so a production `EnvironmentFile` can
never be overridden by a stale development file.

```bash
# PUBLIC: safe to bundle into the app
EXPO_PUBLIC_REVENUECAT_API_KEY=your_public_revenuecat_sdk_key
EXPO_PUBLIC_PSST_BACKEND_URL=https://your-psst-backend.example.com

# SERVER-SIDE SECRETS: read only by server/
ELEVENLABS_API_KEY=server_only_secret
SARVAM_API_KEY=server_only_secret
```

| Variable | Visibility | Consumer |
| --- | --- | --- |
| `EXPO_PUBLIC_REVENUECAT_API_KEY` | Public (ships in the bundle) | RevenueCat SDK in the app |
| `EXPO_PUBLIC_PSST_BACKEND_URL` | Public | App → backend realtime connection |
| `EXPO_PUBLIC_PSST_BACKEND_TOKEN` | Public | Only when the backend sets `PSST_CLIENT_TOKEN`. A shared token, **not** authentication |
| `EXPO_PUBLIC_PSST_MODE` | Public | Optional engine pin (`realtime`/`mock`) |
| `ELEVENLABS_API_KEY` | **Server-side secret** | `server/src/elevenlabs.js` only |
| `SARVAM_API_KEY` | **Server-side secret** | `server/src/sarvam.js` only |

### Security and trust model

`EXPO_PUBLIC_PSST_BACKEND_TOKEN` is a **shared token, not authentication**. It is inlined into the app
bundle by definition, so anyone who has the APK has the token: it gates casual access to a test
backend and nothing more. Real authorization — verifying the caller's Psst Pro entitlement server-side
(RevenueCat webhook or REST API) plus per-user rate limiting — is a **public-release gate** and is not
implemented yet. Until then the backend should only be exposed to testers, and it stays reachable
under its own limits (see `server/README.md`).

Transport is enforced rather than assumed: a release build refuses a non-TLS backend URL instead of
opening an insecure `ws://` connection (see `src/services/backend.ts`).

- **Never** access `ELEVENLABS_API_KEY` or `SARVAM_API_KEY` from React Native client code.
- **Never** create `EXPO_PUBLIC_ELEVENLABS_API_KEY` or `EXPO_PUBLIC_SARVAM_API_KEY`.
- **Never** embed either key in the Expo bundle, hardcode it, log it or send it to the client.
- Keep both permanent keys on the server. The app only ever talks to the backend URL.

Verified for this build: after `expo export --platform android`, both server-side keys appear **0
times** in the bundle (the public RevenueCat key appears, as intended).

---

## RevenueCat setup

1. Create a project in the RevenueCat dashboard and add your Google Play app.
2. Create an entitlement with the identifier `pro` (see `PRO_ENTITLEMENT_ID` in
   `src/services/revenuecat.ts`).
3. Attach subscription products to that entitlement and add them to an offering.
4. Build and publish a paywall for the offering in the RevenueCat dashboard.
5. Put the **public mobile SDK key** in `.env` as `EXPO_PUBLIC_REVENUECAT_API_KEY`.

The app calls RevenueCat through `src/services/revenuecat.ts`: the SDK is imported lazily inside
`try/catch`, `initializePurchases()` reports `ready | missing-key | unsupported-platform |
unavailable` instead of throwing, and no prices are hardcoded.

---

## Backend limits

The backend bounds everything a client could grow without limit, all overridable by environment
variable: WebSocket payload size, per-frame audio size, total audio per session, provider queue bytes
and age, concurrent sessions, idle timeout, session duration and audio frames per second. Control
frames (pause/resume/stop) are never throttled, so a session can always be ended. `GET /health`
reports the effective numbers. The full table lives in `server/README.md`.

Two ceilings end a session on their own, whichever comes first, and both do it the same visible way:
one `notice` explaining which limit was reached, then a clean end that flushes what was already
accepted and still delivers a recap. At the defaults, the **audio budget** (96 MiB) is the binding
one for a real device — about 17½ minutes of continuous 48 kHz mono PCM16 (~52 min at 16 kHz) — while
the **duration ceiling** is 60 minutes of wall-clock session time. Audio sent after either is dropped
without repeating the explanation; the app stops capturing as soon as the end reaches it. If you
raise one, raise the other with it so they stay consistent.

Session ids come from the app's URL, and a second live connection claiming an id that is already
streaming is refused with `409 Conflict` rather than silently taking over the first session. Once
End is tapped, the app treats the session as terminal: a delayed `listening` acknowledgement can
never restart capture or reopen the audio path, and the recap still arrives.

## Expo Go limitations

- **RevenueCat** needs native code: in Expo Go the app reports "Purchases aren't available here",
  keeps `isPro` false and stays fully usable.
- **Realtime audio** needs `expo-audio`'s native audio stream: in Expo Go use the **Demo** engine.
- The **Demo** engine runs anywhere, including the web preview.

---

## EAS Android build

Android is the initial shipping platform (Samsung Galaxy S24 Ultra target). Builds are produced with
EAS from this Ubuntu Azure VM — no local Android Studio required.

`eas.json` at the repository root defines three profiles:

| Profile | Output | Purpose |
| --- | --- | --- |
| `development` | APK with `expo-dev-client` | iterative work against a Metro server |
| `preview` | **installable APK** | the S24 acceptance run (`distribution: internal`) |
| `production` | AAB | store release |

`eas.json` deliberately contains **no project ID and no `android.package`**: those identify *your*
app store listing, so they must be chosen by the project owner rather than invented here. Set the
package once (`npx eas-cli init` links the project, or add `expo.android.package` to `app.json`),
then builds are reproducible from this file.

`EXPO_PUBLIC_*` values are inlined **at build time**, so the backend URL must be provided to the
build (an EAS environment variable), not only placed in a local `.env`:

```bash
npx eas-cli login
npx eas-cli init                                    # links a project ID (or set it yourself)
npx eas-cli env:create --name EXPO_PUBLIC_PSST_BACKEND_URL --value https://your-psst-backend.example.com --visibility plaintext --scope project
npx eas-cli build --platform android --profile preview       # installable APK for the S24
```

Notes:

- The `preview` APK needs no Metro server: it is a release build with `expo-audio`'s native stream and
  RevenueCat compiled in, which is exactly what a realtime session requires.
- The `development` profile **requires `expo-dev-client`**, which is not currently a dependency:
  `npx expo install expo-dev-client` before using it. A dev-client build also needs Metro reachable
  from the phone (same Wi-Fi with the VM's LAN IP, or `npx expo start --tunnel`), and the same
  reachability applies to `EXPO_PUBLIC_PSST_BACKEND_URL` — `localhost` on the VM is not the phone.
- Put `ELEVENLABS_API_KEY` and `SARVAM_API_KEY` in the **backend service's** environment on the VM,
  never in an `EXPO_PUBLIC_*` variable.
- `app.json` enables the microphone permission and deliberately leaves **background recording off**:
  Psst only listens during a session you started and can see. The app also closes the microphone
  itself when it leaves the foreground.

---

## Testing on a Samsung Galaxy S24 Ultra

Prerequisites: `EXPO_PUBLIC_PSST_BACKEND_URL` set to an **`https://`** origin for the build, the
backend reachable from the phone over TLS, and the certificate trusted by the phone. A release build
refuses a plain-text backend URL instead of silently opening an insecure socket; only a development
build may use `http://` on the local network. `localhost` on the VM is not reachable from the phone.

1. Build and install the **`preview`** APK (`npx eas-cli build --platform android --profile preview`).
2. Open Psst → **Start a Psst**.
3. Choose the **Sales** preset. Engine: **Live audio**.
4. Goal: *"Understand the customer's budget before offering a discount."*
5. Tap **Start listening** and grant microphone access.
6. Confirm the header shows `LIVE`, `LISTENING` and the chip shows `REALTIME AUDIO` + `MIC LIVE`.
7. Say: *"We really like the product, but two thousand dollars per month is above our budget."*
8. Your actual words must appear in the transcript as they are spoken.
9. Within a few seconds, a real cue should appear, similar in intent to *(not hardcoded)*:
   `Psst… / They haven't revealed their budget. / Ask what range they expected.`
10. Tap **Pause**: the chip switches to `MIC OFF`, audio stops and the transcript stays. **Resume**
    continues the same session.
11. Say one clear last sentence, then tap **End session**. The mic must stop immediately (the chip
    reads `MIC OFF`), and that final sentence must be in the recap.

If step 8 fails, the LIVE screen shows the reason (a warning from the backend or a connection
error) — it never substitutes demo transcript text.

### S24 acceptance checklist

| # | Check | Expected |
| --- | --- | --- |
| 1 | Tap **End** mid-sentence | microphone and outgoing audio stop at once; the recap still arrives |
| 2 | Final sentence before **End** | it appears in the recap's key points |
| 3 | **Pause** → speak → **Resume** | no audio, transcript or cue while paused; resume continues the same session |
| 4 | Home/lock while listening | capture stops (chip `MIC OFF`); the session is not left running unseen |
| 5 | Airplane mode mid-session | ONE clear failure notice, no silent demo fallback, honest recap still offered |
| 6 | Real cue latency | a genuine cue appears within a few seconds of the trigger sentence |
| 7 | **Pause** → **Resume** quickly after speaking | no cue about the pre-pause sentence appears after resume; new speech still cues normally |
| 8 | Leave the session running to the audio/duration limit (or set a small `PSST_MAX_SESSION_AUDIO_BYTES` on a test backend) | ONE notice naming the limit, capture stops, a recap is still delivered |
| 9 | Second device/tab opening the same session id while one is live | the second connection is refused (409); the first session keeps working |
| 10 | `GET /health` on the VM | `elevenlabsConfigured`/`sarvamConfigured` true, limits listed, no key material |

Backend-side checks while the phone is connected:

```bash
curl -s https://your-psst-backend.example.com/health | jq
# { "status": "ok", "phase": "2b", "elevenlabsConfigured": true, "sarvamConfigured": true, ... }
```

---

## Reasoning rules (server)

- **Only committed utterances are reasoned about.** Partials are display-only: they stream to the
  screen but never reach the model.
- **A gate decides whether a call is warranted** at all (minimum word count, minimum gap, one
  in-flight call), keeping latency and cost down.
- **Cue suppression** (`server/src/cue.js`) drops duplicates, near-identical advice, low-confidence
  cues and anything arriving inside `PSST_MIN_CUE_INTERVAL_MS` (default 12 s).
- **Anything malformed, slow or weak becomes `NO_ACTION`.** A live conversation is never interrupted
  because a provider failed, and no cue is ever invented locally.
- **Pause/resume** keeps the transcript and conversation state and does not recreate the provider
  session.
- **A final arriving while an evaluation is running is coalesced**, not dropped: the latest relevant
  utterance is evaluated as soon as the current request finishes. A result that comes back after a
  pause, stop or detach is discarded before it can reach the screen.
- **Pause is a boundary, not a bookmark.** Pausing invalidates in-flight reasoning and clears queued
  work, so a cue about speech from before the pause cannot surface after the user resumes; nothing is
  reasoned about while paused, while the transcript keeps being recorded for the recap.
- **On stop**, the session stops accepting audio immediately, the provider is asked to commit with
  the documented flush (an empty `input_audio_chunk` with `commit: true`), the final transcript is
  given a bounded window to land, and only then is the provider socket closed — the microphone is
  never kept open to force a commit. If the model recap fails or times out, the backend returns a
  recap built from what was actually captured, and the app has its own fallback.

---

## Verification

Run in this repository:

| Check | Result |
| --- | --- |
| `npm test` | **70 passed, 0 failed** — 53 backend + 17 app transport, offline, no provider credit |
| `npm run server:smoke` | passes (offline, no provider credit) |
| `npm run lint` | 0 errors, 0 warnings (the backend and the test suites are linted as Node ESM now) |
| `npx tsc --noEmit` | clean |
| `npx expo-doctor` | 21/21 |
| `npx expo export --platform android` | bundle succeeds; scanning it finds **0** occurrences of either server-side key value and **0** of their names |
| `npm run server:providers` | previously recorded: 10 passed, 0 failed — real ElevenLabs STT, real Sarvam decision |
| `npm run server:providers -- --recap` | adds the model-written recap; **recap coverage requires this flag** |

`npm test` is the offline suite (Node's built-in runner). It drives the production code against a
local fake STT endpoint and a fake socket, and covers the defects these phases fixed: a malformed
`audio.frame` reaching the message handler, an object-valued `seq`/`byteLength`/`audio.sampleRate`
that `Number()` throws on (with a valid frame parsed afterwards), a sample rate arriving at the
provider unchanged (16 k, 44.1 k and 48 k, through the real wire), disconnect during STT connection
setup, no microphone frames after Stop while the recap is delayed, a delayed `status: listening`
after End neither restarting capture nor letting audio out while the recap still lands, the pause
boundary invalidating in-flight reasoning (and new speech still producing a fresh cue),
final-utterance preservation through a stop, pending-final coalescing, stale-cue rejection, duplicate
and over-limit session ids (409/503, with slots freed and cleaned up), the audio budget ending a
session visibly with an honest recap, and bounded audio buffering. It never calls a provider and
never needs a microphone.

`server:providers` synthesises the acceptance sentence with ElevenLabs TTS, streams it through the
production STT client and feeds the resulting real transcript to Sarvam. It asserts a cue for the
price objection, `NO_ACTION` for small talk and suppression of a repeated cue. Measured results:
real transcript *"We really like the product, but 2,000 dollars per month is above our budget."*,
cues such as *"They stated their budget ceiling." / "Ask what their target range is."*, reasoning
latency ≈ 2.8 s, recap ≈ 3.5 s (with `-- --recap`). It was not re-run for this repair pass: it makes
real, billable provider calls, and the offline suite now covers the same code paths structurally.

**Not verified:** microphone capture and app → backend streaming from a physical device. This
machine has no microphone, so real STT has only been proven server-side, and the microphone
lifecycle (open, stop on End, stop when backgrounded) has only been proven by type/lint checks,
offline tests of the transport gate and code inspection. Treat the on-device steps above as the
remaining acceptance test.

---

## Privacy UX

- Psst only listens during sessions you start, and always shows a visible listening indicator plus
  the microphone state.
- Every session can be paused or ended at any time, and audio stops immediately.
- Audio is never stored: frames are streamed, counted and discarded. Only the transcript is kept,
  in memory, for the duration of the session.
- PREP explains that everyone involved should be comfortable with audio processing and that
  applicable consent rules must be followed, in plain language rather than legal boilerplate.

See `server/README.md` for the backend's protocol details, design rules and Azure deployment steps.
