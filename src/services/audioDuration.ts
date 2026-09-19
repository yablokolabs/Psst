/**
 * Best-effort duration for an imported recording.
 *
 * The audio player is already in the app, so it can report the length of a file
 * without a decoder of our own. It is deliberately best-effort: a player that
 * never loads (an unusual container, a codec the device lacks) resolves to 0
 * rather than blocking the import, and the backend measures the real length from
 * the transcript either way.
 */

import { createAudioPlayer } from 'expo-audio';

/** Long enough for a local file to load, short enough not to stall the screen. */
const LOAD_TIMEOUT_MS = 2500;

export async function readAudioDurationMs(uri: string): Promise<number> {
  let player: ReturnType<typeof createAudioPlayer> | null = null;

  try {
    player = createAudioPlayer({ uri });

    const duration = await new Promise<number>((resolve) => {
      const finish = (seconds: number) => {
        clearTimeout(timer);
        subscription?.remove();
        resolve(seconds);
      };

      const timer = setTimeout(() => finish(player?.duration ?? 0), LOAD_TIMEOUT_MS);

      // The first loaded status carries the duration; later ones are ignored.
      const subscription = player?.addListener('playbackStatusUpdate', (status) => {
        if (status.isLoaded && status.duration > 0) finish(status.duration);
      });

      // A file that is already loaded may not emit another status update.
      if (player && player.isLoaded && player.duration > 0) finish(player.duration);
    });

    return Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0;
  } catch {
    return 0;
  } finally {
    try {
      player?.remove();
    } catch {
      // The player was never created, or native already released it.
    }
  }
}
