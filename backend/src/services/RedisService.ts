import {
  Artist,
  isPlaylistType,
  isTrackOwnership,
  Playlist,
  PlaylistData,
  PlaylistType,
  ReleaseDateSource,
  Track,
  TrackOwnership,
} from "@smart-music-library/shared";
import { randomUUID } from "crypto";
import { commandOptions } from "redis";
import { gunzipSync, gzipSync } from "zlib";
import { redisClient } from "../redis";

export type MusicSource = "yt-music";

// Root namespace prefix. Kept as-is (rather than renamed with the project)
// so existing users' data stays readable.
const KEY_PREFIX = "smart-spotify";

// Synced library data is fully rebuilt on every resync, so it's safe to let
// it expire after a period of inactivity instead of keeping it forever.
export const LIBRARY_TTL_SECONDS = 30 * 24 * 60 * 60;

// User annotations (wishlist/ownership marks, playlist types) can't be
// rebuilt from YouTube, so they outlive the library cache by a wide margin.
// The TTL is refreshed on every write.
export const ANNOTATIONS_TTL_SECONDS = 365 * 24 * 60 * 60;

const DELETE_BATCH_SIZE = 500;

// Upstash (and other managed Redis) cap request size; stay well below 1 MB.
export const SNAPSHOT_CHUNK_BYTES = 900 * 1024;
// Parsed snapshots kept in memory (a few users' libraries).
const SNAPSHOT_CACHE_SIZE = 4;

export const LIKED_SONGS_PLAYLIST_ID = "liked-songs";

export interface SyncMeta {
  /** True when written by a sync that records release-date sources. */
  hasReleaseDates?: boolean;
  /** True when the library is stored as a snapshot (current format). */
  hasSnapshot?: boolean;
  lastSync: string;
  playlistCount: number;
  trackCount: number;
  artistCount: number;
  skippedPlaylists: number;
}

type RedisHash = Record<string, string>;

function isNonEmptyHash(value: unknown): value is RedisHash {
  return !!value && typeof value === "object" && Object.keys(value).length > 0;
}

/**
 * A whole synced library, stored as one gzip-compressed JSON document per
 * generation. Annotations (ownership, playlist types) are not part of it;
 * they're overlaid at read time. Counts and relations are derived.
 */
interface LibrarySnapshot {
  v: 1;
  playlists: Record<string, Playlist>;
  /** Ordered track ids per playlist (also for playlists not in `playlists`). */
  playlistTrackIds: Record<string, string[]>;
  tracks: Record<string, Track>;
  artists: Record<string, Artist>;
}

interface LoadedSnapshot {
  rev: string | null;
  data: LibrarySnapshot;
  /** trackId -> playlist ids containing it (derived) */
  trackPlaylists: Map<string, string[]>;
  /** artistId -> track ids credited to it (derived) */
  artistTracks: Map<string, string[]>;
}

const emptySnapshot = (): LibrarySnapshot => ({
  v: 1,
  playlists: {},
  playlistTrackIds: {},
  tracks: {},
  artists: {},
});

function index(data: LibrarySnapshot, rev: string | null): LoadedSnapshot {
  const trackPlaylists = new Map<string, string[]>();
  for (const [playlistId, ids] of Object.entries(data.playlistTrackIds)) {
    for (const id of ids) {
      const list = trackPlaylists.get(id);
      if (list) list.push(playlistId);
      else trackPlaylists.set(id, [playlistId]);
    }
  }
  const artistTracks = new Map<string, string[]>();
  for (const track of Object.values(data.tracks)) {
    for (const artistId of track.artistIds) {
      const list = artistTracks.get(artistId);
      if (list) list.push(track.id);
      else artistTracks.set(artistId, [track.id]);
    }
  }
  return { rev, data, trackPlaylists, artistTracks };
}

// Small LRU of parsed snapshots, validated against the stored revision on
// every read (one tiny GET), so it's safe across processes and resets.
const snapshotCache = new Map<string, LoadedSnapshot>();

function cacheGet(key: string): LoadedSnapshot | undefined {
  const hit = snapshotCache.get(key);
  if (hit) {
    snapshotCache.delete(key);
    snapshotCache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: LoadedSnapshot) {
  snapshotCache.delete(key);
  snapshotCache.set(key, value);
  while (snapshotCache.size > SNAPSHOT_CACHE_SIZE) {
    snapshotCache.delete(snapshotCache.keys().next().value!);
  }
}

/**
 * All Redis access for one user's library.
 *
 * Key layout (per user, per source):
 *
 *   smart-spotify:{uid}:{source}:current-gen          -> id of the live generation
 *   smart-spotify:{uid}:{source}:lastSyncedAt         -> survives library expiry
 *   smart-spotify:{uid}:{source}:annotations:ownership       (hash trackId -> state)
 *   smart-spotify:{uid}:{source}:annotations:playlist-types  (hash playlistId -> type)
 *   smart-spotify:{uid}:{source}:last-job / sync-lock        (job bookkeeping)
 *
 *   smart-spotify:{uid}:{source}:g:{gen}:meta         -> sync stats (hash)
 *   smart-spotify:{uid}:{source}:g:{gen}:snapshot     -> "{rev}:{chunks}" header
 *   smart-spotify:{uid}:{source}:g:{gen}:snapshot:N   -> gzip JSON chunk(s)
 *
 * The library itself is one compressed snapshot per generation rather than
 * thousands of per-track/per-artist keys: a page view then costs a handful
 * of Redis commands instead of tens of thousands, which matters on
 * command-metered plans (e.g. Upstash's free tier).
 *
 * A sync writes a brand-new generation and only flips `current-gen` once it
 * has fully succeeded, so readers never see a half-built (or, after a
 * failure, empty) library. Libraries stored in older formats (per-entity
 * keys, with or without generations) have no snapshot: they read as empty
 * and the app asks for a resync, which cleans them up.
 */
export class RedisService {
  constructor(
    readonly userId: string,
    readonly generation: string | null,
    readonly source: MusicSource = "yt-music",
  ) {}

  /** Library reader/writer for the user's currently live generation. */
  static async forUser(
    userId: string,
    source: MusicSource = "yt-music",
  ): Promise<RedisService> {
    const generation = await redisClient.get(
      RedisService.rootKey(userId, source, "current-gen"),
    );
    return new RedisService(userId, generation, source);
  }

  static rootKey(userId: string, source: MusicSource, ...parts: string[]) {
    return [KEY_PREFIX, userId, source, ...parts].join(":");
  }

  private root(...parts: string[]) {
    return RedisService.rootKey(this.userId, this.source, ...parts);
  }

  private key(type: string, ...parts: string[]): string {
    const base = this.generation
      ? this.root("g", this.generation)
      : this.root();
    return [base, type, ...parts].join(":");
  }

  private snapshotKey(...parts: string[]) {
    return this.key("snapshot", ...parts);
  }

  private cacheKey() {
    return this.key("snapshot");
  }

  private ownershipKey() {
    return this.root("annotations", "ownership");
  }

  private playlistTypesKey() {
    return this.root("annotations", "playlist-types");
  }

  // ---------------------------------------------------------------------
  // Generation lifecycle
  // ---------------------------------------------------------------------

  /**
   * Makes `generation` the live one and deletes the previous generation
   * (or the legacy namespace). Copies any legacy annotations first so a
   * user's wishlist/playlist types survive the migration.
   */
  static async activateGeneration(
    userId: string,
    generation: string,
    source: MusicSource = "yt-music",
  ): Promise<void> {
    const previous = await RedisService.forUser(userId, source);
    if (previous.generation === generation) return;

    if (previous.generation === null) {
      await previous.migrateLegacyAnnotations();
    }

    await redisClient.set(
      RedisService.rootKey(userId, source, "current-gen"),
      generation,
    );

    await previous.deleteLibraryData();
  }

  /** Deletes this generation's library data (or the legacy namespace). */
  async deleteLibraryData(): Promise<void> {
    if (this.generation) {
      await this.deleteMatching(`${this.root("g", this.generation)}:*`);
      return;
    }

    // Legacy namespace: everything directly under the root except the
    // root-level bookkeeping keys and generation data.
    const base = this.root();
    const keep = new Set(
      [
        "current-gen",
        "lastSyncedAt",
        "last-job",
        "sync-lock",
        "release-lookup",
        "annotations:ownership",
        "annotations:playlist-types",
      ].map((k) => `${base}:${k}`),
    );
    await this.deleteMatching(
      `${base}:*`,
      (key) => !keep.has(key) && !key.startsWith(`${base}:g:`),
    );
  }

  /** Deletes everything stored for this user/source, annotations included. */
  static async deleteAllUserData(
    userId: string,
    source: MusicSource = "yt-music",
  ): Promise<void> {
    const svc = new RedisService(userId, null, source);
    await svc.deleteMatching(`${svc.root()}:*`);
  }

  // Uses SCAN (incremental) instead of KEYS (blocking), and UNLINK in
  // batches so a large library doesn't produce one enormous command.
  private async deleteMatching(
    match: string,
    filter: (key: string) => boolean = () => true,
  ): Promise<void> {
    let batch: string[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await redisClient.unlink(batch);
      batch = [];
    };

    const keys: string[] = [];
    for await (const key of redisClient.scanIterator({
      MATCH: match,
      COUNT: 1000,
    })) {
      keys.push(key);
    }

    for (const key of keys) {
      if (!filter(key)) continue;
      batch.push(key);
      if (batch.length >= DELETE_BATCH_SIZE) await flush();
    }
    await flush();
  }

  private async migrateLegacyAnnotations(): Promise<void> {
    // Pre-generation per-entity layout (indexes + hashes under the root).
    const [trackIds, playlistIds] = await Promise.all([
      redisClient.sMembers(this.key("tracks-index")),
      redisClient.sMembers(this.key("playlists-index")),
    ]);
    if (trackIds.length === 0 && playlistIds.length === 0) return;

    const pipeline = redisClient.multi();
    trackIds.forEach((id) => pipeline.hGet(this.key("track", id), "ownership"));
    playlistIds.forEach((id) =>
      pipeline.hGet(this.key("playlist", id), "playlistType"),
    );
    const results = (await pipeline.exec()) as unknown as (string | null)[];

    const writes = redisClient.multi();
    let hasWrites = false;
    trackIds.forEach((id, i) => {
      const value = results[i];
      if (isTrackOwnership(value) && value !== TrackOwnership.NOT_OWNED) {
        writes.hSetNX(this.ownershipKey(), id, value);
        hasWrites = true;
      }
    });
    playlistIds.forEach((id, i) => {
      const value = results[trackIds.length + i];
      if (isPlaylistType(value)) {
        writes.hSetNX(this.playlistTypesKey(), id, value);
        hasWrites = true;
      }
    });
    if (!hasWrites) return;

    writes.expire(this.ownershipKey(), ANNOTATIONS_TTL_SECONDS);
    writes.expire(this.playlistTypesKey(), ANNOTATIONS_TTL_SECONDS);
    await writes.exec();
  }

  // ---------------------------------------------------------------------
  // Sync metadata
  // ---------------------------------------------------------------------

  async setSyncMeta(meta: SyncMeta): Promise<void> {
    const metaKey = this.key("meta");
    await redisClient
      .multi()
      .hSet(metaKey, {
        lastSync: meta.lastSync,
        playlistCount: String(meta.playlistCount),
        trackCount: String(meta.trackCount),
        artistCount: String(meta.artistCount),
        skippedPlaylists: String(meta.skippedPlaylists),
        releaseDates: "1",
        storage: "snapshot",
      })
      .expire(metaKey, LIBRARY_TTL_SECONDS)
      // Kept without a TTL so we can tell "never synced" apart from
      // "synced, but the cached data has since expired".
      .set(this.root("lastSyncedAt"), meta.lastSync)
      .exec();
  }

  async getLastSyncedAt(): Promise<string | null> {
    return redisClient.get(this.root("lastSyncedAt"));
  }

  async getSyncMeta(): Promise<SyncMeta | null> {
    const data = await redisClient.hGetAll(this.key("meta"));
    if (!isNonEmptyHash(data)) return null;

    return {
      lastSync: data.lastSync || "",
      playlistCount: Number(data.playlistCount || 0),
      trackCount: Number(data.trackCount || 0),
      artistCount: Number(data.artistCount || 0),
      skippedPlaylists: Number(data.skippedPlaylists || 0),
      hasReleaseDates: data.releaseDates === "1",
      hasSnapshot: data.storage === "snapshot",
    };
  }

  // ---------------------------------------------------------------------
  // Annotations
  // ---------------------------------------------------------------------

  async updatePlaylistType(
    playlistId: string,
    playlistType: PlaylistType,
  ): Promise<void> {
    await redisClient
      .multi()
      .hSet(this.playlistTypesKey(), playlistId, playlistType)
      .expire(this.playlistTypesKey(), ANNOTATIONS_TTL_SECONDS)
      .exec();
    this.playlistTypesMemo = undefined;
  }

  async updateTrackOwnership(
    trackId: string,
    ownership: TrackOwnership,
  ): Promise<void> {
    const key = this.ownershipKey();
    const pipeline = redisClient.multi();
    if (ownership === TrackOwnership.NOT_OWNED) {
      pipeline.hDel(key, trackId);
    } else {
      pipeline.hSet(key, trackId, ownership);
    }
    pipeline.expire(key, ANNOTATIONS_TTL_SECONDS);
    await pipeline.exec();
    this.ownershipMemo = undefined;
  }

  private getOwnershipMap(): Promise<RedisHash> {
    this.ownershipMemo ??= redisClient.hGetAll(this.ownershipKey());
    return this.ownershipMemo;
  }

  private getPlaylistTypeMap(): Promise<RedisHash> {
    this.playlistTypesMemo ??= redisClient.hGetAll(this.playlistTypesKey());
    return this.playlistTypesMemo;
  }

  private applyOwnership(track: Track, ownership: RedisHash): Track {
    const value = ownership[track.id];
    if (isTrackOwnership(value)) track.ownership = value;
    return track;
  }

  private applyPlaylistType(playlist: Playlist, types: RedisHash): Playlist {
    const value = types[playlist.id];
    if (isPlaylistType(value)) playlist.playlistType = value;
    return playlist;
  }

  // ---------------------------------------------------------------------
  // Snapshot storage
  // ---------------------------------------------------------------------

  // Set while a batch() is running: writes then mutate this in memory and
  // are saved once when the batch ends.
  private pending: LoadedSnapshot | null = null;

  // Request-scoped memos: a RedisService is created per request (forUser),
  // and one page view can read the library dozens of times (e.g. stats over
  // every playlist). Load the snapshot and annotations once per instance.
  private loaded?: Promise<LoadedSnapshot>;
  private ownershipMemo?: Promise<RedisHash>;
  private playlistTypesMemo?: Promise<RedisHash>;

  /**
   * Loads the library snapshot: one GET for the "{rev}:{chunks}" header,
   * plus one MGET for the chunks only when the cached copy is stale.
   */
  private load(): Promise<LoadedSnapshot> {
    if (this.pending) return Promise.resolve(this.pending);
    this.loaded ??= this.loadFromRedis().catch((err) => {
      this.loaded = undefined;
      throw err;
    });
    return this.loaded;
  }

  private async loadFromRedis(): Promise<LoadedSnapshot> {
    const header = await redisClient.get(this.snapshotKey());
    if (!header) return index(emptySnapshot(), null);

    const [rev, countText] = header.split(":");
    const cached = cacheGet(this.cacheKey());
    if (cached && cached.rev === rev) return cached;

    const count = Number(countText) || 0;
    const chunks = await redisClient.mGet(
      commandOptions({ returnBuffers: true }),
      Array.from({ length: count }, (_, i) => this.snapshotKey(String(i))),
    );
    if (chunks.some((c) => !c)) {
      // Header without data (e.g. expired mid-way): treat as no library.
      return index(emptySnapshot(), null);
    }

    const json = gunzipSync(Buffer.concat(chunks as Buffer[])).toString("utf8");
    const loaded = index(JSON.parse(json) as LibrarySnapshot, rev);
    cacheSet(this.cacheKey(), loaded);
    return loaded;
  }

  /** Writes the snapshot (chunked) and a new header in one MULTI. */
  private async save(data: LibrarySnapshot): Promise<void> {
    const compressed = gzipSync(JSON.stringify(data));
    const chunks: Buffer[] = [];
    for (let i = 0; i < compressed.length; i += SNAPSHOT_CHUNK_BYTES) {
      chunks.push(compressed.subarray(i, i + SNAPSHOT_CHUNK_BYTES));
    }
    if (chunks.length === 0) chunks.push(Buffer.alloc(0));

    const rev = randomUUID();
    const pipeline = redisClient.multi();
    chunks.forEach((chunk, i) =>
      pipeline.set(this.snapshotKey(String(i)), chunk, {
        EX: LIBRARY_TTL_SECONDS,
      }),
    );
    pipeline.set(this.snapshotKey(), `${rev}:${chunks.length}`, {
      EX: LIBRARY_TTL_SECONDS,
    });
    await pipeline.exec();

    const loaded = index(data, rev);
    cacheSet(this.cacheKey(), loaded);
    this.loaded = Promise.resolve(loaded);
  }

  /** Load → mutate → save, or just mutate inside a batch(). */
  private async mutate(fn: (data: LibrarySnapshot) => void): Promise<void> {
    if (this.pending) {
      fn(this.pending.data);
      return;
    }
    const current = await this.load();
    // Work on a copy so a failed write can't leave the cache half-mutated.
    const next = structuredClone(current.data);
    fn(next);
    await this.save(next);
  }

  /**
   * Runs `fn` with all library writes buffered in memory, then saves the
   * snapshot once. Used by the sync job, which writes many times.
   */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending) return fn();
    const current = await this.load();
    this.pending = index(structuredClone(current.data), current.rev);
    try {
      const result = await fn();
      await this.save(this.pending.data);
      return result;
    } finally {
      this.pending = null;
    }
  }

  // ---------------------------------------------------------------------
  // Writes (used by the sync job and by mutations)
  // ---------------------------------------------------------------------

  async storePlaylists(playlists: Playlist[]): Promise<void> {
    if (playlists.length === 0) return;
    await this.mutate((data) => {
      for (const playlist of playlists) {
        // playlistType is an annotation, never stored in the library.
        const { playlistType: _annotation, ...rest } = playlist;
        void _annotation;
        data.playlists[playlist.id] = rest;
      }
    });
  }

  async storeTracks(playlistId: string, tracks: Track[]): Promise<void> {
    if (tracks.length === 0) return;
    await this.mutate((data) => {
      data.playlistTrackIds[playlistId] = tracks.map((t) => t.id);
      for (const track of tracks) data.tracks[track.id] = stripTrack(track);
    });
  }

  async storeArtists(artists: Artist[]): Promise<void> {
    if (artists.length === 0) return;
    await this.mutate((data) => {
      for (const artist of artists) data.artists[artist.id] = artist;
    });
  }

  /** Appends a track to a playlist in the cache (no-op if already there). */
  async addTrackToPlaylist(playlistId: string, track: Track): Promise<void> {
    await this.mutate((data) => {
      const ids = (data.playlistTrackIds[playlistId] ??= []);
      if (ids.includes(track.id)) return;
      ids.push(track.id);
      data.tracks[track.id] ??= stripTrack(track);
    });
  }

  async removeTrackFromPlaylist(
    playlistId: string,
    trackId: string,
  ): Promise<void> {
    await this.mutate((data) => {
      const ids = data.playlistTrackIds[playlistId];
      if (ids)
        data.playlistTrackIds[playlistId] = ids.filter((id) => id !== trackId);
      // Track no longer in any playlist: remove it from the library.
      const stillListed = Object.values(data.playlistTrackIds).some((list) =>
        list.includes(trackId),
      );
      if (!stillListed) delete data.tracks[trackId];
    });
  }

  /**
   * Applies looked-up release dates to cached tracks' albums. Returns how
   * many of the given albums exist in this library.
   */
  async updateAlbumReleaseDates(
    updates: {
      albumId: string;
      releaseDate: string;
      source: ReleaseDateSource;
    }[],
  ): Promise<number> {
    if (updates.length === 0) return 0;
    const byAlbum = new Map(updates.map((u) => [u.albumId, u]));
    const applied = new Set<string>();
    await this.mutate((data) => {
      for (const track of Object.values(data.tracks)) {
        const update = track.album?.id
          ? byAlbum.get(track.album.id)
          : undefined;
        if (!update) continue;
        track.album.releaseDate = update.releaseDate;
        track.album.releaseDateSource = update.source;
        applied.add(update.albumId);
      }
    });
    return applied.size;
  }

  // Set while background release-date lookups are queued for this user.
  private releaseLookupKey() {
    return this.root("release-lookup");
  }

  /** Returns true if this call claimed the flag (no lookup was pending). */
  async claimReleaseLookup(ttlSeconds: number): Promise<boolean> {
    const ok = await redisClient.set(this.releaseLookupKey(), "1", {
      NX: true,
      EX: ttlSeconds,
    });
    return ok === "OK";
  }

  async refreshReleaseLookup(ttlSeconds: number): Promise<void> {
    await redisClient.set(this.releaseLookupKey(), "1", { EX: ttlSeconds });
  }

  async clearReleaseLookup(): Promise<void> {
    await redisClient.del(this.releaseLookupKey());
  }

  async isReleaseLookupPending(): Promise<boolean> {
    return (await redisClient.exists(this.releaseLookupKey())) === 1;
  }

  // ---------------------------------------------------------------------
  // Reads (computed in memory from the snapshot + annotations)
  // ---------------------------------------------------------------------

  /** Copies of the given tracks with ownership overlaid, input order kept. */
  private async hydrate(
    snapshot: LoadedSnapshot,
    trackIds: string[],
  ): Promise<{ index: number; track: Track }[]> {
    if (trackIds.length === 0) return [];
    const ownership = await this.getOwnershipMap();
    const out: { index: number; track: Track }[] = [];
    trackIds.forEach((id, index) => {
      const stored = snapshot.data.tracks[id];
      if (!stored) return;
      const track: Track = {
        ...stored,
        album: { ...stored.album },
        ownership: TrackOwnership.NOT_OWNED,
      };
      out.push({ index, track: this.applyOwnership(track, ownership) });
    });
    return out;
  }

  async getTrack(trackId: string): Promise<Track | null> {
    const [entry] = await this.hydrate(await this.load(), [trackId]);
    return entry?.track ?? null;
  }

  async getUserTracks(): Promise<Track[]> {
    const snapshot = await this.load();
    const tracks = (
      await this.hydrate(snapshot, Object.keys(snapshot.data.tracks))
    ).map((e) => e.track);
    return tracks.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    const snapshot = await this.load();
    const ids = snapshot.data.playlistTrackIds[playlistId] ?? [];
    return (await this.hydrate(snapshot, ids)).map(({ index, track }) => {
      track.playlistPosition = index;
      return track;
    });
  }

  async getArtistTracks(artistId: string): Promise<Track[]> {
    const snapshot = await this.load();
    const ids = snapshot.artistTracks.get(artistId) ?? [];
    return (await this.hydrate(snapshot, ids)).map((e) => e.track);
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    const snapshot = await this.load();
    const ids = Object.values(snapshot.data.tracks)
      .filter((t) => t.album?.id === albumId)
      .map((t) => t.id);
    return (await this.hydrate(snapshot, ids)).map((e) => e.track);
  }

  async getTrackPlaylistMemberships(
    trackIds: string[],
  ): Promise<Record<string, string[]>> {
    const snapshot = await this.load();
    const membershipMap: Record<string, string[]> = {};
    for (const id of trackIds) {
      membershipMap[id] = [...(snapshot.trackPlaylists.get(id) ?? [])];
    }
    return membershipMap;
  }

  private playlistWithCount(
    snapshot: LoadedSnapshot,
    playlist: Playlist,
    types: RedisHash,
  ): Playlist {
    return this.applyPlaylistType(
      {
        ...playlist,
        trackCount: snapshot.data.playlistTrackIds[playlist.id]?.length ?? 0,
      },
      types,
    );
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    const snapshot = await this.load();
    const playlists = Object.values(snapshot.data.playlists);
    if (playlists.length === 0) return [];
    const types = await this.getPlaylistTypeMap();
    return playlists.map((p) => this.playlistWithCount(snapshot, p, types));
  }

  async getPlaylist(playlistId: string): Promise<Playlist | null> {
    const snapshot = await this.load();
    const playlist = snapshot.data.playlists[playlistId];
    if (!playlist) return null;
    const types = await this.getPlaylistTypeMap();
    return this.playlistWithCount(snapshot, playlist, types);
  }

  async getUserArtists(): Promise<Artist[]> {
    const snapshot = await this.load();
    return Object.values(snapshot.data.artists).map((artist) => ({
      ...artist,
      trackCount: snapshot.artistTracks.get(artist.id)?.length ?? 0,
    }));
  }

  async getArtist(artistId: string): Promise<Artist | null> {
    const snapshot = await this.load();
    const artist = snapshot.data.artists[artistId];
    if (!artist) return null;
    return {
      ...artist,
      trackCount: snapshot.artistTracks.get(artistId)?.length ?? 0,
    };
  }

  async getPlaylistData(playlistId: string): Promise<PlaylistData | null> {
    const playlist = await this.getPlaylist(playlistId);
    if (!playlist) return null;

    const snapshot = await this.load();
    const tracks = await this.getPlaylistTracks(playlistId);
    if (tracks.length === 0) {
      return { playlist, tracks, artists: [], genres: [], totalDurationMs: 0 };
    }

    const artistTrackCount = new Map<string, number>();
    let totalDurationMs = 0;
    for (const track of tracks) {
      totalDurationMs += track.durationMs;
      for (const artistId of track.artistIds) {
        artistTrackCount.set(
          artistId,
          (artistTrackCount.get(artistId) || 0) + 1,
        );
      }
    }

    const artists: Artist[] = [];
    const artistGenres = new Map<string, Set<string>>();
    for (const [artistId, trackCount] of artistTrackCount) {
      const artist = snapshot.data.artists[artistId];
      if (!artist) continue;
      artists.push({ ...artist, trackCount });
      artistGenres.set(artist.id, new Set(artist.genres));
    }

    // Count genres by track (not by artist track count)
    const genreCount = new Map<string, number>();
    tracks.forEach((track) => {
      const trackGenres = new Set<string>();
      track.artistIds.forEach((artistId) => {
        artistGenres.get(artistId)?.forEach((genre) => trackGenres.add(genre));
      });
      trackGenres.forEach((genre) => {
        genreCount.set(genre, (genreCount.get(genre) || 0) + 1);
      });
    });

    const genres = Array.from(genreCount.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    artists.sort((a, b) => b.trackCount - a.trackCount);

    return { playlist, tracks, artists, genres, totalDurationMs };
  }
}

/** Library copy of a track: annotations and per-playlist fields dropped. */
function stripTrack(track: Track): Track {
  const { playlistPosition: _position, ...rest } = track;
  void _position;
  return { ...rest, ownership: TrackOwnership.NOT_OWNED };
}
