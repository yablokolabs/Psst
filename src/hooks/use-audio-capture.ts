/**
 * Microphone capture for a live Psst session.
 *
 * Uses expo-audio's native `AudioStream` (SDK 57), which delivers real-time PCM
 * buffers rather than a finished recording file: Psst streams audio as it is
 * spoken instead of uploading a recording afterwards.
 *
 * This hook owns capture only. Where the frames go is not its concern — it hands
 * them to `onFrame`, and the conversation service owns the transport. That keeps
 * provider logic out of the LIVE screen and keeps the UI free of socket code.
 *
 * Capture runs only while the session is listening **and** the app is in the
 * foreground. `enableBackgroundRecording: false` in `app.json` stops Android
 * from recording while backgrounded, but it does not stop an in-flight
 * `AudioStream`: the stream is closed explicitly here whenever the app leaves
 * the foreground (Home, app switcher, lock screen), so the microphone is never
 * held open by a screen the user cannot see.
 */

import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
  type AudioStreamBuffer,
} from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { MIC_CHANNELS, MIC_ENCODING, MIC_SAMPLE_RATE } from '@/constants/audio';
import type { MicrophoneFrame } from '@/types/conversation';

export type MicrophoneStatus =
  /** Not capturing: no session, the session is paused, or the app is hidden. */
  | 'idle'
  /** Permission prompt in flight, or the native stream is starting. */
  | 'requesting'
  /** Buffers are flowing to the session. */
  | 'capturing'
  /** The user declined microphone access. */
  | 'denied'
  /** The native stream failed to start or delivered unusable audio. */
  | 'error';

export interface UseAudioCaptureOptions {
  /** Capture only while true. Driven by the session status. */
  active: boolean;
  onFrame: (frame: MicrophoneFrame) => void;
}

export interface UseAudioCaptureResult {
  status: MicrophoneStatus;
  /** User-facing problem, or null. Never contains provider credentials. */
  error: string | null;
  /** The rate the device is actually delivering. */
  sampleRate: number;
  /** True while buffers are reaching the session. */
  isCapturing: boolean;
}

type Permission = 'unknown' | 'granted' | 'denied';

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The microphone could not be started.';
}

export function useAudioCapture({ active, onFrame }: UseAudioCaptureOptions): UseAudioCaptureResult {
  const [permission, setPermission] = useState<Permission>('unknown');
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sampleRate, setSampleRate] = useState(MIC_SAMPLE_RATE);
  /**
   * Foreground state. Anything other than `active` means the user is not
   * looking at the session, so Psst must not be listening.
   */
  const [appState, setAppState] = useState<AppStateStatus>(() => AppState.currentState);

  // The native stream holds its own callback, so this reads the latest rate
  // through a ref instead of re-registering a listener on every buffer.
  const rateRef = useRef(MIC_SAMPLE_RATE);

  const handleBuffer = useCallback(
    (buffer: AudioStreamBuffer) => {
      // Realtime STT is a mono feed: interleaved channels would corrupt the
      // audio, so stop rather than send something the backend has to reject.
      if (buffer.channels !== MIC_CHANNELS) {
        setFailure('This device delivered multi-channel audio, which Psst cannot stream.');
        return;
      }

      const pcm = buffer.data instanceof Uint8Array ? buffer.data : new Uint8Array(buffer.data);
      if (pcm.byteLength === 0) return;

      // Report the delivered rate so the UI can show it. Frames carry the rate
      // themselves; nothing is resampled anywhere in the pipeline.
      if (rateRef.current !== buffer.sampleRate) {
        rateRef.current = buffer.sampleRate;
        setSampleRate(buffer.sampleRate);
      }

      onFrame({
        pcm,
        sampleRate: buffer.sampleRate,
        channels: buffer.channels,
        encoding: MIC_ENCODING,
      });
    },
    [onFrame]
  );

  const { stream, isStreaming } = useAudioStream({
    sampleRate: MIC_SAMPLE_RATE,
    channels: MIC_CHANNELS,
    encoding: MIC_ENCODING,
    onBuffer: handleBuffer,
  });

  // Home, app switcher, lock screen and incoming calls all leave `active`.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setAppState(next);
    });
    return () => subscription.remove();
  }, []);

  /** Single source of truth for whether the microphone may be open right now. */
  const shouldCapture = active && appState === 'active';

  useEffect(() => {
    let cancelled = false;

    const stopCapture = () => {
      try {
        stream.stop();
      } catch {
        // Already stopped, or the native module is unavailable in this build.
      }
    };

    if (!shouldCapture) {
      // Leaving the foreground, pausing or ending the session all land here, and
      // the microphone is closed explicitly rather than left to the recording
      // config.
      stopCapture();
      return;
    }

    const startCapture = async () => {
      setStarting(true);
      setFailure(null);

      try {
        let granted = (await getRecordingPermissionsAsync()).granted;
        if (!granted) {
          granted = (await requestRecordingPermissionsAsync()).granted;
        }
        if (cancelled) return;

        if (!granted) {
          setPermission('denied');
          return;
        }

        setPermission('granted');
        // Keep the microphone usable regardless of silent mode or other audio.
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await stream.start();
        if (cancelled) {
          stopCapture();
          return;
        }
      } catch (captureError) {
        if (cancelled) return;
        setFailure(describe(captureError));
      } finally {
        if (!cancelled) setStarting(false);
      }
    };

    void startCapture();

    return () => {
      cancelled = true;
      stopCapture();
    };
  }, [shouldCapture, stream]);

  // Status is derived from native state and the request lifecycle rather than
  // written from inside the effect, so there is a single source of truth.
  const status = useMemo<MicrophoneStatus>(() => {
    // While the app is hidden, report the truth: nothing is being captured.
    if (!shouldCapture) return 'idle';
    if (failure) return 'error';
    if (permission === 'denied') return 'denied';
    if (isStreaming) return 'capturing';
    if (starting) return 'requesting';
    return 'idle';
  }, [shouldCapture, failure, permission, isStreaming, starting]);

  const error = useMemo(() => {
    if (!shouldCapture) return null;
    if (failure) return failure;
    if (permission === 'denied') {
      return 'Psst needs microphone access to listen to the conversation.';
    }
    return null;
  }, [shouldCapture, failure, permission]);

  return { status, error, sampleRate, isCapturing: status === 'capturing' };
}
