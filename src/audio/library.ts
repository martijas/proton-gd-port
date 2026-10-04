// Fetching and decoding sound, once each.
//
// A decoded AudioBuffer is raw PCM — a three-minute song is about 60 MB of
// 32-bit samples at 44.1 kHz stereo, more at 48 kHz — so music is decoded
// only while something needs it: a channel playing it, a song a Song trigger
// has prepared, or the level's own track while the level is loaded. The rest
// of the songs a level can ask for are fetched ahead but kept compressed, and
// decoded on first use. Effects are small and are kept, but a level only
// preloads the ones its own triggers name.
//
// Codec: the sound effects and the music library's songs are Ogg Vorbis,
// which everything but Safari plays. The build can write an m4a beside each
// one (`--transcode`), and this picks whichever the browser admits to
// supporting. When neither works the effects go quiet and the music — which
// is mp3 and plays everywhere — carries on; that is a recorded gap rather
// than a failure to start.

import { assetUrl } from "../assets/paths";
import { sfxUrl as onlineSfxUrl, songUrl as onlineSongUrl } from "../online/api";
import type { MusicSource } from "./music";

export type Codec = "ogg" | "m4a";

interface Song {
  buffer: AudioBuffer | null;
  job: Promise<AudioBuffer | null> | null;
  refs: number;
}

export class AudioLibrary implements MusicSource {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Map<string, Promise<AudioBuffer | null>>();
  private readonly songs = new Map<string, Song>();
  /** Compressed songs fetched ahead, decoded on first use. */
  private readonly bytes = new Map<string, Promise<ArrayBuffer | null>>();
  readonly codec: Codec | null;

  constructor(private readonly ctx: BaseAudioContext) {
    this.codec = pickCodec();
  }

  /** An effect, decoded and kept. Null when it is missing or undecodable. */
  async effect(path: string): Promise<AudioBuffer | null> {
    const have = this.buffers.get(path);
    if (have) return have;
    const already = this.pending.get(path);
    if (already) return already;
    const job = this.fetchBytes(path)
      .then((data) => (data ? this.decode(data) : null))
      .then((buffer) => {
        if (buffer) this.buffers.set(path, buffer);
        this.pending.delete(path);
        return buffer;
      });
    this.pending.set(path, job);
    return job;
  }

  /** Decodes several effects at once, ignoring the ones that are not there. */
  async preload(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map((p) => this.effect(p)));
  }

  /** A decoded effect, or null. */
  get(path: string): AudioBuffer | null {
    return this.buffers.get(path) ?? this.songs.get(path)?.buffer ?? null;
  }

  /** Keeps an effect's decoded buffer under another name, a pitch-shifted copy. */
  keep(name: string, buffer: AudioBuffer): void {
    this.buffers.set(name, buffer);
  }

  /** Forgets every decoded effect. */
  clearEffects(): void {
    this.buffers.clear();
  }

  // --- music -------------------------------------------------------------------

  retain(path: string): void {
    this.song(path).refs++;
  }

  /**
   * One user fewer. The buffer goes once nothing holds it — checked a moment
   * later, so a channel restarted on the same song in the same breath (a
   * respawn) does not decode it again.
   */
  release(path: string): void {
    const song = this.songs.get(path);
    if (!song) return;
    song.refs--;
    queueMicrotask(() => {
      if (song.refs <= 0 && this.songs.get(path) === song) this.songs.delete(path);
    });
  }

  /** A song, decoded. Kept while something retains it. */
  load(path: string): Promise<AudioBuffer | null> {
    const song = this.song(path);
    if (song.buffer) return Promise.resolve(song.buffer);
    if (!song.job) {
      song.job = this.fetchBytes(path)
        .then((data) => (data ? this.decode(data.slice(0)) : null))
        .then((buffer) => {
          song.buffer = buffer;
          song.job = null;
          return buffer;
        });
    }
    return song.job;
  }

  /** Fetches a song's compressed bytes, to decode when it is first played. */
  prefetch(path: string): void {
    void this.fetchBytes(path);
  }

  /** Forgets every prefetched song. */
  clearPrefetched(): void {
    this.bytes.clear();
  }

  private song(path: string): Song {
    let song = this.songs.get(path);
    if (!song) {
      song = { buffer: null, job: null, refs: 0 };
      this.songs.set(path, song);
    }
    return song;
  }

  private fetchBytes(path: string): Promise<ArrayBuffer | null> {
    const have = this.bytes.get(path);
    if (have) return have;
    // A page instead of a sound is a file that is not there: the dev server
    // answers a missing one with its index page rather than a 404.
    const get = (url: string): Promise<ArrayBuffer | null> =>
      fetch(url)
        .then((res) => (res.ok && !res.headers.get("content-type")?.includes("text/html") ? res.arrayBuffer() : null))
        .catch(() => null);
    // Online levels ask for songs and library sounds the build never shipped:
    // a Newgrounds song never is, and a library one only when an official
    // level uses it. Those come from where the host config points instead.
    const online = onlineUrl(path);
    const fromOnline = (): Promise<ArrayBuffer | null> =>
      online ? online.url().then((url) => (url ? get(url) : null), () => null) : Promise.resolve(null);
    const job = online?.only ? fromOnline() : get(assetUrl(path)).then((data) => data ?? fromOnline());
    // Effects are decoded once and kept, so only the music library's songs
    // keep their bytes, until the next level.
    if (path.startsWith("audio/songs/")) this.bytes.set(path, job);
    void job.then((data) => {
      if (!data) this.bytes.delete(path);
    });
    return job;
  }

  private async decode(data: ArrayBuffer): Promise<AudioBuffer | null> {
    try {
      return await this.ctx.decodeAudioData(data);
    } catch {
      return null;
    }
  }
}

/**
 * Where a sound the build may not have shipped can be fetched instead.
 * `only` when the build never ships it, so the asset is not tried first.
 */
function onlineUrl(path: string): { url: () => Promise<string | null>; only: boolean } | null {
  const song = /^audio\/songs\/(\d+)\.(mp3|ogg|m4a)$/.exec(path);
  if (song) return { url: () => onlineSongUrl(Number(song[1])), only: song[2] === "mp3" };
  const sfx = /^audio\/sfx\/s(\d+)\.(ogg|m4a)$/.exec(path);
  if (sfx) return { url: () => onlineSfxUrl(Number(sfx[1])), only: false };
  return null;
}

/**
 * What this browser will admit to playing. `canPlayType` answers "probably",
 * "maybe" or "" — anything non-empty is worth trying, and a file that then
 * fails to decode simply does not play.
 */
function pickCodec(): Codec | null {
  const probe = document.createElement("audio");
  if (probe.canPlayType('audio/ogg; codecs="vorbis"')) return "ogg";
  if (probe.canPlayType('audio/mp4; codecs="mp4a.40.2"')) return "m4a";
  return null;
}
