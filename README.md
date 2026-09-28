# Psst

**Record anywhere. Let Psst remember everything.**

Psst turns a call recording into a debrief: what was decided, who owes what by when, the questions
nobody answered, and the follow-ups you promised. It is not a call recorder and it never joins a
call — you bring a recording you already have (your own, or one someone sent you) and Psst does the
remembering.

## Why Psst does not record calls

Android does not allow it, for good reasons. `AudioPlaybackCapture` only captures audio from apps
that play `USAGE_MEDIA`/`USAGE_GAME` and opt in, and call audio is excluded; `CAPTURE_AUDIO_OUTPUT`,
which `VOICE_CALL` needs, is a signature-level permission no installed app can hold. A phone's own
recorder can save a call (and does, where the law allows), so Psst takes that file instead of
pretending it can tap the line.

## Status

Import-first MVP, working end to end on a physical device path:

| Piece | State |
|---|---|
| Import from Files (`.m4a`, `.mp3`, `.wav`, `.aac`) | working |
| Required consent acknowledgement before anything is uploaded | working |
| Backend analysis: batch transcription + debrief | working, live on `https://psst.yablokolabs.com` |
| SQLite timeline with search, survives restarts | working |
| Tick follow-ups, create calendar reminders, copy the follow-up message, share the debrief | working |
| Delete the recording (keep the debrief) / delete the debrief | working |
| Offline demo debrief when no backend is configured or reachable | working |
| Share-sheet target ("Share → Psst") | **not built yet** — needs `expo-share-intent` and a rebuild |
| Real authentication / entitlement check | **public-release gate** — the shared token is a throttle, not auth |

## The flow

1. **Record** — with a phone recorder, a call recorder, or whatever produced the file.
2. **Import** — `Import a recording` → Files → the file is copied into app storage, and the title,
   contact and date are prefilled from its name (all editable).
3. **Consent** — a required, unchecked-by-default acknowledgement, shown *before* the upload:
   *"I confirm I have the right and any required consent to upload and analyze this recording."*
4. **Analyse** — upload progress, then transcription, then the debrief. A long call takes minutes.
5. **Debrief** — summary, key decisions, commitments with owner and deadline, follow-ups, a
   ready-to-send follow-up message, people mentioned, open questions, risks, tone and relationship,
   and the reminders worth being nudged about.
6. **Follow through** — tick tasks, add calendar reminders, copy the message, share the debrief, and
   search the whole timeline later.

## Architecture

```
recording (Files) -> Expo app (expo-document-picker)
  -> POST /debrief  (raw audio body, metadata in the query)
  -> Psst backend -> ElevenLabs batch STT (scribe_v2, diarized)
                  -> Sarvam structured completion -> Debrief JSON
  <- debrief -> SQLite on the device (expo-sqlite) -> timeline and search
```

The backend is a single Node process with no framework and no database: an upload is transcribed,
analysed and discarded. It is the only thing that holds `ELEVENLABS_API_KEY` and `SARVAM_API_KEY`;
the app only ever holds a public backend URL.

### App layout

```
src/
  app/
    index.tsx       Home: import CTA, sample debrief, timeline with search
    import.tsx      pick file -> consent -> prefilled details -> progress
    debrief.tsx     everything the call left behind, plus task/edit/delete actions
    settings.tsx    retention, delete all, Pro, backend status
    pro.tsx         RevenueCat paywall
  components/       DebriefRow, DebriefSection, TaskRow, AudioReviewCard, Checkbox, ...
  hooks/
    use-debriefs.tsx     the timeline: load, edit, delete, search
  services/
    debriefDb.ts         SQLite repository + recording file storage
    debriefRows.ts       pure row mapping and search predicates (unit tested in Node)
    debriefPayload.ts    defensive parser for the backend's JSON
    debriefAnalysis.ts   upload transport + offline demo fallback
    demoDebrief.ts       the offline generator and the first-run examples
    reminders.ts         calendar events for follow-ups
    backend.ts           backend URL handling; TLS enforced for uploads
  types/debrief.ts  the domain model
```

### The debrief model (`src/types/debrief.ts`)

A `Debrief` keeps the source facts (`audio`, `recordedAt`, `consentAt`, `durationMs`), the analysis
(`summary`, `keyDecisions`, `commitments`, `tasks`, `people`, `openQuestions`, `risks`, `tone`,
`relationship`, `reminders`, `suggestedMessage`), and two honesty flags:

- `origin` — `backend` or `demo`;
- `degraded` — true when the analysis was thinner than requested (no model configured, provider
  failed, or the summary is empty), so the UI can say so instead of showing blank sections as if
  they were analysed.

Diarization labels survive as `TranscriptLine.label` (`"Speaker 1"`) while `speaker` stays
`'unknown'`. A recording cannot tell which voice is the user's, and guessing would misattribute
every commitment in the debrief, so Psst shows the label and says nothing more.

## Backend API

### `POST /debrief`

```
POST /debrief?callType=sales&title=Acme%20pilot&contact=Priya&durationMs=1860000[&token=…]
Content-Type: audio/mp4

<raw audio bytes>
```

Metadata travels in the query string so the body stays the recording itself: a single contiguous
upload the phone can report progress for, and no multipart parser on the server.

`200` returns:

```json
{
  "ok": true,
  "origin": "backend",
  "degraded": false,
  "notice": null,
  "transcript": { "lines": [{ "speaker": "unknown", "label": "Speaker 1", "text": "…", "at": 0 }],
                  "durationMs": 1860000, "languageCode": "eng" },
  "debrief": { "summary": "…", "keyDecisions": [], "commitments": [], "tasks": [], "people": [],
               "openQuestions": [], "risks": [], "tone": { "label": "", "note": "" },
               "relationship": "", "reminders": [], "suggestedMessage": "" }
}
```

| Status | Meaning |
|---|---|
| `400` | not an audio body, empty recording, or an aborted upload |
| `401` | a client token is required and missing or wrong |
| `413` | larger than `maxImportBytes`, or longer than `maxImportDurationMs` |
| `429` | too many imports this minute, or too many at once |
| `502` | the transcription provider failed (the recording is fine) |
| `503` | no transcription provider is configured — the app falls back to its offline demo |

A `degraded: true` with a `notice` means the transcript exists but the summary does not, which is
still worth returning.

### `GET /health`

Booleans, names and numbers only — never key material. Reports `importAnalysisReady`,
`batchSttModel`, `batchSttDiarize`, per-import counters, and the limits, including
`limits.maxImportBytes`, `maxImportDurationMs`, `maxImportsPerMinute` and `maxConcurrentImports`.

### Legacy WebSocket session API (dormant)

`ws://…/sessions/{id}/stream` still exists — the live cue engine was built on it and it is still
covered by tests — but the app no longer opens it. It is kept until removing it is a deliberate
change rather than a side effect of this pivot.

## Local development

```bash
npm install
npm --prefix server install
cp .env.example .env                 # app values: backend URL (public)
cp server/.env.example server/.env   # provider keys (secrets — never in the app env)

npm run server:dev                   # backend on http://127.0.0.1:8787
npm run preflight                    # checks the import path, no provider call
npm start                            # Expo dev server
```

`npm run preflight` is the fastest way to know whether a build will work: it walks the app's own URL,
`GET /health`, and two rejections that prove the import route is live — a non-audio body (`400`) and,
when a token is required, a missing token (`401`). It never uploads a recording, so it costs nothing.

## Environment variables

```bash
# PUBLIC: safe to bundle into the app
EXPO_PUBLIC_PSST_BACKEND_URL=https://psst.yablokolabs.com
EXPO_PUBLIC_PSST_BACKEND_TOKEN=          # optional shared throttle, not authentication
EXPO_PUBLIC_REVENUECAT_API_KEY=          # public SDK key, when Pro is enabled

# SERVER-SIDE SECRETS: server/.env only, never the app's env, never EXPO_PUBLIC_*
ELEVENLABS_API_KEY=      # batch STT
SARVAM_API_KEY=          # debrief generation
PSST_CLIENT_TOKEN=       # optional shared throttle
HOST=127.0.0.1           # loopback: the tunnel is the only ingress
PORT=8787
```

The provider keys live in `server/.env`; the root `.env` is loaded by the Expo CLI and exported, so
a provider key there would be one `EXPO_PUBLIC_` prefix away from the bundle. Optional tuning:
`ELEVENLABS_STT_FILE_MODEL`, `ELEVENLABS_STT_FILE_ENDPOINT`, `ELEVENLABS_STT_LANGUAGE`,
`ELEVENLABS_STT_DIARIZE`, `PSST_MAX_IMPORT_BYTES`, `PSST_MAX_IMPORT_DURATION_MS`,
`PSST_MAX_IMPORTS_PER_MINUTE`, `PSST_MAX_CONCURRENT_IMPORTS`, `PSST_STT_FILE_TIMEOUT_MS`.

### Security and trust model

- The app holds a public backend URL and an optional public token. Neither is a secret.
- `EXPO_PUBLIC_PSST_BACKEND_TOKEN` is a throttle. It ships inside the bundle and anyone can read it
  out of the APK, so it is not authentication, and it is not described as any.
- A release build refuses to upload a recording to a non-TLS backend (`src/services/backend.ts`),
  rather than silently downgrading `https` to a plaintext POST.
- Consent is required, unchecked by default, and shown before the first byte leaves the device.
- Uploads are never written to disk on the backend; only the transcript and debrief come back.

## RevenueCat

`src/services/revenuecat.ts` reads `EXPO_PUBLIC_REVENUECAT_API_KEY` and degrades to `missing-key`
without throwing, so a build without it still runs the whole import flow. Entitlement is presentational
until the backend verifies it: server-side entitlement is a public-release gate.

Until Psst exists in Google Play the only key we have is a Test Store key (`test_…`), and the SDK
deliberately closes the app when it finds one in a build that is not debuggable. That is why
`plugins/with-test-store-debuggable.js` marks the `preview` profile debuggable: it is gated on the EAS
profile name, so `production` can never pick it up. Swapping in the real `goog_…` key retires the
plugin and the profile can go back to a plain release build.

## Backend limits

Everything a hostile or broken client could grow without bound has a ceiling, all overridable by
environment variable and all reported (as numbers) by `/health`.

| Limit | Default | Enforced |
|---|---|---|
| `maxImportBytes` | 50 MB | while reading the body; the request is drained, not reset, so the 413 is delivered |
| `maxImportDurationMs` | 4 hours | from the transcript, after transcription measures it |
| `maxImportsPerMinute` | 6 | before the body is read |
| `maxConcurrentImports` | 2 | before the body is read |
| `maxPayloadBytes` / session limits | 256 KB / … | legacy WebSocket path, unchanged |

## EAS Android build

```bash
npx eas-cli login
npx eas-cli env:create --name EXPO_PUBLIC_PSST_BACKEND_URL \
  --value https://psst.yablokolabs.com --visibility plaintext --scope project --environment preview
npx eas-cli build --platform android --profile preview
```

`eas.json`'s `preview` profile sets `"environment": "preview"`, which is what makes the `eas env`
value available at build time — a cloud build does **not** see your local `.env`.

**A build from before this pivot is stale**: the app gained four native modules
(`expo-document-picker`, `expo-sqlite`, `expo-calendar`, `expo-clipboard`), so a new APK is required
before the import flow can be tested on a device. The old build has no import screen at all.

Optional development build (one build, then reload forever — no rebuild for JS changes):

```bash
npx eas-cli build --platform android --profile development
npx expo start --tunnel
```

## Testing on a Samsung Galaxy S24 Ultra

### Reaching the backend from the phone

The backend listens on `127.0.0.1:8787` only, and a named Cloudflare tunnel publishes it at a stable
hostname — no inbound port, no firewall rule, no certificate to manage:

```
S24 --TLS 443--> Cloudflare edge ==(outbound connection held open)==> cloudflared --> 127.0.0.1:8787
```

```bash
# Install the units (they carry their own notes; on the VM they are already running)
sudo cp deploy/psst-backend.service deploy/cloudflared.service /etc/systemd/system/
sudo cp deploy/cloudflared-config.yml /etc/cloudflared/config.yml
sudo systemctl daemon-reload
sudo systemctl enable --now psst-backend cloudflared

systemctl status psst-backend cloudflared      # both enabled = they come back after a reboot
journalctl -u psst-backend -f                  # live backend log
```

`deploy/psst-backend.service` runs the live checkout as the interactive user, so a code change only
needs `sudo systemctl restart psst-backend`. `server/README.md` documents the hardened production
variant (`/opt/psst`, a dedicated `psst` service user, secrets in `/etc/psst-backend.env`).

One trap worth knowing: systemd reads `EnvironmentFile=` **after** `Environment=`, so a `HOST` in
`server/.env` silently wins over the unit file. `HOST` therefore lives in exactly one place.

### What to watch while the phone runs

```bash
curl -s http://127.0.0.1:8787/health | python3 -m json.tool | head -30
```

`importsCompleted` rising means an import really landed; `importsRejected`, `importsTooLarge` and
`importsUnavailable` explain the failures; `activeImports` shows work in flight. The backend log has
one line per finished import (`bytes`, transcript lines, seconds, full vs transcript-only, duration).

### S24 acceptance checklist

Setup: the phone is on the new APK, the backend and tunnel are `active`, and `npm run preflight`
passes for the URL baked into the build.

| # | Check | Expected |
|---|---|---|
| 1 | Launch, tap **Import a recording** | Files opens filtered to audio |
| 2 | Pick an `.m4a` from Files | Title/contact/date prefilled from the name; all editable |
| 3 | **Create debrief** with consent unticked | Button stays disabled with a reason |
| 4 | Tick consent, create | Upload % then "Reading the call"; no microphone prompt ever |
| 5 | Debrief appears | Summary, decisions, commitments, follow-ups populated |
| 6 | Tick a follow-up | It stays ticked after leaving and reopening the app |
| 7 | **Remind me** on a follow-up | Calendar permission asked once; event appears in the phone calendar |
| 8 | **Copy follow-up** then paste into a message | The suggested message, unedited |
| 9 | **Share debrief** | Share sheet opens with the full text debrief |
| 10 | Search the timeline for a name from the call | The debrief is found |
| 11 | **Delete recording**, reopen the debrief | Debrief intact, recording card says it was deleted |
| 12 | Import while in airplane mode | One honest notice, a demo debrief, nothing uploaded |
| 13 | Import a `.mp4` / oversized file | Refused with a reason that says what Psst accepts |
| 14 | Force-quit and relaunch | Every debrief and tick is still there |
| 15 | Tap **Delete this debrief** | It disappears from the timeline and stays gone |

Not on this list: no microphone row, because the app no longer requests `RECORD_AUDIO` at all.

## Privacy UX

- Psst never records a call, never joins one, and asks for no microphone permission.
- Nothing is uploaded until the consent box is ticked, and the copy never claims the user has the
  right to record — *"Recording other people may require their permission, and the rules differ by
  country. Psst does not decide that for you."*
- The recording is copied into app storage so it survives the picker's cache, and `Delete recording`
  is one tap on the debrief itself.
- Deleting a recording keeps the debrief; deleting a debrief removes both. `Settings` deletes
  everything at once, behind a confirmation.
- An offline demo debrief is always labelled `DEMO ANALYSIS` and never pretends to have read the
  user's audio.

## Verification

Checks that were actually run for this change:

| Check | Result |
|---|---|
| `npm run test:server` | 76 passed, 0 failed (61 existing + 15 new) |
| `npm run test:client` | 36 passed, 0 failed |
| `npx tsc --noEmit` | clean |
| `npx expo lint` | clean |
| `npm run preflight -- --url https://psst.yablokolabs.com` | import path PASS (health, route rejections) |
| `POST /debrief` over the real wire | exercised offline against fake providers, including the multipart body, diarization labels, and every rejection path |

Not run, and not claimed: no EAS build for this pivot yet, no physical-device run, and no live
provider call (the suites use local fakes and an injected `fetch`, so nothing is billed).

## Still to do

- **Share-sheet target** — register Psst for `ACTION_SEND` on `audio/*` so "Share → Psst" works. This
  is the primary described workflow and needs `expo-share-intent` plus a rebuild.
- **Real authorization** — the shared token is a throttle. Server-side entitlement checks are the
  gate before this is public.
- **Named tunnel vs quick tunnel** — the named tunnel is stable; a rebuilt APK is still needed if the
  hostname ever changes.
- **Language pinning** — `ELEVENLABS_STT_LANGUAGE` is unset, so STT auto-detects. Mis-transcriptions
  on accented speech are the signal to pin it.
- **Deeper debriefs** — the model writes one shape for every call type. Tuning per call type is the
  next quality step, not a correctness fix.
