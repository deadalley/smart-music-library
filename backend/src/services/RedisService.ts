import {
  Album,
  Artist,
  convertFromRedisAlbum,
  convertFromRedisArtist,
  convertFromRedisPlaylist,
  convertFromRedisTrack,
  convertToRedisAlbum,
  convertToRedisArtist,
  convertToRedisPlaylist,
  convertToRedisTrack,
  isPlaylistType,
  isTrackOwnership,
  Playlist,
  PlaylistData,
  PlaylistType,
  ReleaseDateSource,
  Track,
  TrackOwnership,
} from "@smart-music-library/shared";
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
const WRITE_CHUNK_SIZE = 200;

export const LIKED_SONGS_PLAYLIST_ID = "liked-songs";

export interface SyncMeta {
  /** True when written by a sync that records release-date sources. */
  hasReleaseDates?: boolean;
  lastSync: string;
  playlistCount: number;
  trackCount: number;
  artistCount: number;
  skippedPlaylists: number;
}

type RedisHash = Record<string, string>;

function isNonEmptyHash(value: unknown): value is RedisHash {
  return (
    !!value && typeof value === "object" && Object.keys(value).length > 0
  );
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
 *   smart-spotify:{uid}:{source}:g:{gen}:{type}:...    -> synced library data
 *
 * A sync writes a brand-new generation and only flips `current-gen` once it
 * has fully succeeded, so readers never see a half-built (or, after a
 * failure, empty) library. Users who synced before generations existed have
 * no `current-gen`; their data lives directly under
 * `smart-spotify:{uid}:{source}:{type}:...` (the "legacy" namespace) and
 * stays readable until their next sync migrates it.
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

  // Explicit indexes of known IDs (rather than discovering them via SCAN +
  // glob match) so enumeration can't silently miss entries.
  private playlistIndexKey() {
    return this.key("playlists-index");
  }

  private artistIndexKey() {
    return this.key("artists-index");
  }

  private trackIndexKey() {
    return this.key("tracks-index");
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
    const [trackIds, playlistIds] = await Promise.all([
      redisClient.sMembers(this.trackIndexKey()),
      redisClient.sMembers(this.playlistIndexKey()),
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
  }

  private async getOwnershipMap(): Promise<RedisHash> {
    return redisClient.hGetAll(this.ownershipKey());
  }

  private async getPlaylistTypeMap(): Promise<RedisHash> {
    return redisClient.hGetAll(this.playlistTypesKey());
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
  // Writes (used by the sync job and by mutations)
  // ---------------------------------------------------------------------

  async storePlaylists(playlists: Playlist[]): Promise<void> {
    if (playlists.length === 0) return;

    const pipeline = redisClient.multi();
    for (const playlist of playlists) {
      const playlistKey = this.key("playlist", playlist.id);
      pipeline.hSet(playlistKey, convertToRedisPlaylist(playlist));
      pipeline.expire(playlistKey, LIBRARY_TTL_SECONDS);
    }
    const indexKey = this.playlistIndexKey();
    pipeline.sAdd(
      indexKey,
      playlists.map((p) => p.id),
    );
    pipeline.expire(indexKey, LIBRARY_TTL_SECONDS);

    await pipeline.exec();
  }

  async storeTracks(playlistId: string, tracks: Track[]): Promise<void> {
    if (tracks.length === 0) return;

    const tracksKey = this.key("playlist", playlistId, "tracks");

    // Clear existing sorted set once (maintains order via score).
    await redisClient.del(tracksKey);

    // Scoped to the whole call (not per chunk) so a key shared across many
    // tracks/chunks — an album, or an artist that recurs across dozens of
    // tracks — only gets HSET/SADD + EXPIRE issued once.
    const writtenAlbumIds = new Set<string>();
    const expiredKeys = new Set<string>();

    for (let offset = 0; offset < tracks.length; offset += WRITE_CHUNK_SIZE) {
      const chunk = tracks.slice(offset, offset + WRITE_CHUNK_SIZE);
      const pipeline = redisClient.multi();
      const sortedSetData: { score: number; value: string }[] = [];
      const touched = new Set<string>();

      chunk.forEach((track, i) => {
        const playlistPosition = offset + i;

        const trackKey = this.key("track", track.id);
        pipeline.hSet(
          trackKey,
          convertToRedisTrack({ ...track, playlistPosition }),
        );
        touched.add(trackKey);

        // Album metadata (shared across tracks, stored once). YouTube tracks
        // carry a fabricated per-video "album" (id `${channelId}:${videoId}`)
        // that only exists to carry the track's cover art; the id must stay
        // unique per video or this dedupe would drop every thumbnail but
        // the first. Consumers use `type === "youtube"` to avoid treating it
        // as a real, browsable album.
        const albumId = track.album?.id;
        if (albumId) {
          if (!writtenAlbumIds.has(albumId)) {
            writtenAlbumIds.add(albumId);
            const albumKey = this.key("album", albumId);
            pipeline.hSet(albumKey, convertToRedisAlbum(track.album));
            touched.add(albumKey);
          }
          const albumTracksKey = this.key("album", albumId, "tracks");
          pipeline.sAdd(albumTracksKey, track.id);
          touched.add(albumTracksKey);
        }

        const trackPlaylistsKey = this.key("track", track.id, "playlists");
        pipeline.sAdd(trackPlaylistsKey, playlistId);
        touched.add(trackPlaylistsKey);

        sortedSetData.push({ score: playlistPosition, value: track.id });

        for (const artistId of track.artistIds) {
          const artistTracksKey = this.key("artist", artistId, "tracks");
          pipeline.sAdd(artistTracksKey, track.id);
          touched.add(artistTracksKey);

          const artistPlaylistsKey = this.key("artist", artistId, "playlists");
          pipeline.sAdd(artistPlaylistsKey, playlistId);
          touched.add(artistPlaylistsKey);
        }
      });

      if (sortedSetData.length > 0) {
        pipeline.zAdd(tracksKey, sortedSetData);
        touched.add(tracksKey);
      }

      const trackIndexKey = this.trackIndexKey();
      pipeline.sAdd(
        trackIndexKey,
        chunk.map((t) => t.id),
      );
      touched.add(trackIndexKey);

      for (const key of touched) {
        if (expiredKeys.has(key)) continue;
        expiredKeys.add(key);
        pipeline.expire(key, LIBRARY_TTL_SECONDS);
      }

      await pipeline.exec();
    }
  }

  async storeArtists(artists: Artist[]): Promise<void> {
    if (artists.length === 0) return;

    const pipeline = redisClient.multi();
    for (const artist of artists) {
      const artistKey = this.key("artist", artist.id);
      pipeline.hSet(artistKey, convertToRedisArtist(artist));
      pipeline.expire(artistKey, LIBRARY_TTL_SECONDS);
    }
    const indexKey = this.artistIndexKey();
    pipeline.sAdd(
      indexKey,
      artists.map((a) => a.id),
    );
    pipeline.expire(indexKey, LIBRARY_TTL_SECONDS);

    await pipeline.exec();
  }

  /** Appends an already-cached track to a playlist in the cache. */
  async addTrackToPlaylist(playlistId: string, track: Track): Promise<void> {
    const tracksKey = this.key("playlist", playlistId, "tracks");
    const existingScore = await redisClient.zScore(tracksKey, track.id);
    if (existingScore !== null) return;

    const last = await redisClient.zRangeWithScores(tracksKey, -1, -1);
    const nextPosition = last.length > 0 ? last[0].score + 1 : 0;

    const trackKey = this.key("track", track.id);
    const trackPlaylistsKey = this.key("track", track.id, "playlists");
    const pipeline = redisClient.multi();

    pipeline.hSet(trackKey, convertToRedisTrack(track));
    pipeline.sAdd(this.trackIndexKey(), track.id);
    pipeline.sAdd(trackPlaylistsKey, playlistId);
    pipeline.zAdd(tracksKey, { score: nextPosition, value: track.id });

    const touched = [trackKey, this.trackIndexKey(), trackPlaylistsKey, tracksKey];

    if (track.album?.id) {
      const albumKey = this.key("album", track.album.id);
      const albumTracksKey = this.key("album", track.album.id, "tracks");
      pipeline.hSet(albumKey, convertToRedisAlbum(track.album));
      pipeline.sAdd(albumTracksKey, track.id);
      touched.push(albumKey, albumTracksKey);
    }

    for (const artistId of track.artistIds) {
      const artistTracksKey = this.key("artist", artistId, "tracks");
      const artistPlaylistsKey = this.key("artist", artistId, "playlists");
      pipeline.sAdd(artistTracksKey, track.id);
      pipeline.sAdd(artistPlaylistsKey, playlistId);
      touched.push(artistTracksKey, artistPlaylistsKey);
    }

    touched.forEach((key) => pipeline.expire(key, LIBRARY_TTL_SECONDS));
    await pipeline.exec();
  }

  async removeTrackFromPlaylist(
    playlistId: string,
    trackId: string,
  ): Promise<void> {
    const tracksKey = this.key("playlist", playlistId, "tracks");
    const trackKey = this.key("track", trackId);
    const trackPlaylistsKey = this.key("track", trackId, "playlists");

    const [, , trackData, remainingPlaylists, playlistTrackIds] =
      (await redisClient
        .multi()
        .zRem(tracksKey, trackId)
        .sRem(trackPlaylistsKey, playlistId)
        .hGetAll(trackKey)
        .sMembers(trackPlaylistsKey)
        .zRange(tracksKey, 0, -1)
        .exec()) as unknown as [
        number,
        number,
        RedisHash,
        string[],
        string[],
      ];

    const track = isNonEmptyHash(trackData)
      ? convertFromRedisTrack(trackData)
      : null;
    const artistIds = track?.artistIds ?? [];
    const albumId = track?.album.id;

    const pipeline = redisClient.multi();

    // Track no longer in any playlist: remove it from the library entirely.
    if (remainingPlaylists.length === 0) {
      pipeline.del(trackKey);
      pipeline.sRem(this.trackIndexKey(), trackId);
      if (albumId) pipeline.sRem(this.key("album", albumId, "tracks"), trackId);
      for (const artistId of artistIds) {
        pipeline.sRem(this.key("artist", artistId, "tracks"), trackId);
      }
    }

    // Drop artist -> playlist links when the artist has no other track left
    // in this playlist.
    if (artistIds.length > 0 && playlistTrackIds.length > 0) {
      const lookup = redisClient.multi();
      playlistTrackIds.forEach((id) =>
        lookup.hGet(this.key("track", id), "artistIds"),
      );
      const raw = (await lookup.exec()) as unknown as (string | null)[];
      const stillPresent = new Set<string>();
      raw.forEach((value) => {
        if (!value) return;
        try {
          (JSON.parse(value) as string[]).forEach((a) => stillPresent.add(a));
        } catch {
          // ignore corrupt entries
        }
      });
      for (const artistId of artistIds) {
        if (!stillPresent.has(artistId)) {
          pipeline.sRem(this.key("artist", artistId, "playlists"), playlistId);
        }
      }
    } else {
      for (const artistId of artistIds) {
        pipeline.sRem(this.key("artist", artistId, "playlists"), playlistId);
      }
    }

    await pipeline.exec();
  }

  /**
   * Applies looked-up release dates to cached album hashes. Only touches
   * albums that exist in this generation (a resync may have replaced it).
   */
  async updateAlbumReleaseDates(
    updates: { albumId: string; releaseDate: string; source: ReleaseDateSource }[],
  ): Promise<number> {
    if (updates.length === 0) return 0;

    const exists = redisClient.multi();
    updates.forEach((u) => exists.exists(this.key("album", u.albumId)));
    const present = (await exists.exec()) as unknown as number[];

    const pipeline = redisClient.multi();
    let applied = 0;
    updates.forEach((u, i) => {
      if (!present[i]) return;
      pipeline.hSet(this.key("album", u.albumId), {
        releaseDate: u.releaseDate,
        releaseDateSource: u.source,
      });
      applied += 1;
    });
    if (applied > 0) await pipeline.exec();
    return applied;
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
  // Reads
  // ---------------------------------------------------------------------

  // Fetches album hashes for a batch of (possibly duplicate/empty) album
  // IDs in a single pipelined round trip, deduped.
  private async fetchAlbumsByIds(
    albumIds: (string | undefined)[],
  ): Promise<Map<string, Album>> {
    const uniqueIds = Array.from(
      new Set(albumIds.filter((id): id is string => !!id)),
    );
    const albumMap = new Map<string, Album>();
    if (uniqueIds.length === 0) return albumMap;

    const pipeline = redisClient.multi();
    uniqueIds.forEach((id) => pipeline.hGetAll(this.key("album", id)));
    const results = (await pipeline.exec()) as unknown as RedisHash[];

    uniqueIds.forEach((id, index) => {
      const data = results[index];
      if (isNonEmptyHash(data)) albumMap.set(id, convertFromRedisAlbum(data));
    });

    return albumMap;
  }

  /**
   * Loads and hydrates tracks (album + ownership) for the given ids,
   * preserving the input order and skipping ids with no stored data.
   */
  private async loadTracks(
    trackIds: string[],
  ): Promise<{ id: string; index: number; track: Track }[]> {
    if (trackIds.length === 0) return [];

    const pipeline = redisClient.multi();
    trackIds.forEach((id) => pipeline.hGetAll(this.key("track", id)));
    const [results, ownership] = await Promise.all([
      pipeline.exec() as unknown as Promise<RedisHash[]>,
      this.getOwnershipMap(),
    ]);

    const raw = trackIds
      .map((id, index) => ({ id, index, data: results[index] }))
      .filter((entry) => isNonEmptyHash(entry.data));

    const albumMap = await this.fetchAlbumsByIds(
      raw.map((entry) => entry.data.albumId),
    );

    return raw.map(({ id, index, data }) => ({
      id,
      index,
      track: this.applyOwnership(
        convertFromRedisTrack(data, albumMap.get(data.albumId)),
        ownership,
      ),
    }));
  }

  async getTrack(trackId: string): Promise<Track | null> {
    const [entry] = await this.loadTracks([trackId]);
    return entry?.track ?? null;
  }

  async getUserTracks(): Promise<Track[]> {
    const trackIds = await redisClient.sMembers(this.trackIndexKey());
    const tracks = (await this.loadTracks(trackIds)).map((e) => e.track);
    return tracks.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    const trackIds = await redisClient.zRange(
      this.key("playlist", playlistId, "tracks"),
      0,
      -1,
    );
    return (await this.loadTracks(trackIds)).map(({ index, track }) => {
      // Position from the sorted set order
      track.playlistPosition = index;
      return track;
    });
  }

  async getArtistTracks(artistId: string): Promise<Track[]> {
    const trackIds = await redisClient.sMembers(
      this.key("artist", artistId, "tracks"),
    );
    return (await this.loadTracks(trackIds)).map((e) => e.track);
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    const trackIds = await redisClient.sMembers(
      this.key("album", albumId, "tracks"),
    );
    if (trackIds.length > 0) {
      return (await this.loadTracks(trackIds)).map((e) => e.track);
    }

    // Data synced before the album -> tracks index existed: fall back to
    // scanning the cached library.
    if (!this.generation) {
      const tracks = await this.getUserTracks();
      return tracks.filter((track) => track.album.id === albumId);
    }
    return [];
  }

  // Pipelined lookup of which playlists each of the given tracks belongs to.
  async getTrackPlaylistMemberships(
    trackIds: string[],
  ): Promise<Record<string, string[]>> {
    const membershipMap: Record<string, string[]> = {};
    if (trackIds.length === 0) return membershipMap;

    const pipeline = redisClient.multi();
    trackIds.forEach((trackId) =>
      pipeline.sMembers(this.key("track", trackId, "playlists")),
    );
    const results = (await pipeline.exec()) as unknown as string[][];

    trackIds.forEach((trackId, index) => {
      membershipMap[trackId] = results?.[index] || [];
    });

    return membershipMap;
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    const playlistIds = await redisClient.sMembers(this.playlistIndexKey());
    if (playlistIds.length === 0) return [];

    const pipeline = redisClient.multi();
    for (const playlistId of playlistIds) {
      pipeline.hGetAll(this.key("playlist", playlistId));
      pipeline.zCard(this.key("playlist", playlistId, "tracks"));
    }
    const [results, types] = await Promise.all([
      pipeline.exec() as unknown as Promise<(RedisHash | number)[]>,
      this.getPlaylistTypeMap(),
    ]);

    const playlists: Playlist[] = [];
    playlistIds.forEach((_, index) => {
      const playlistData = results[index * 2];
      const trackCount = results[index * 2 + 1] as number;

      if (isNonEmptyHash(playlistData)) {
        const playlist = convertFromRedisPlaylist(playlistData);
        playlists.push(
          this.applyPlaylistType({ ...playlist, trackCount }, types),
        );
      }
    });

    return playlists;
  }

  async getPlaylist(playlistId: string): Promise<Playlist | null> {
    const [playlistData, trackCount, types] = await Promise.all([
      redisClient.hGetAll(this.key("playlist", playlistId)),
      redisClient.zCard(this.key("playlist", playlistId, "tracks")),
      this.getPlaylistTypeMap(),
    ]);

    if (!isNonEmptyHash(playlistData)) return null;

    return this.applyPlaylistType(
      { ...convertFromRedisPlaylist(playlistData), trackCount },
      types,
    );
  }

  async getUserArtists(): Promise<Artist[]> {
    const artistIds = await redisClient.sMembers(this.artistIndexKey());
    if (artistIds.length === 0) return [];

    const pipeline = redisClient.multi();
    for (const artistId of artistIds) {
      pipeline.hGetAll(this.key("artist", artistId));
      pipeline.sCard(this.key("artist", artistId, "tracks"));
    }
    const results = (await pipeline.exec()) as unknown as (
      | RedisHash
      | number
    )[];

    const artists: Artist[] = [];
    artistIds.forEach((_, index) => {
      const artistData = results[index * 2];
      const trackCount = results[index * 2 + 1] as number;

      if (isNonEmptyHash(artistData)) {
        artists.push({ ...convertFromRedisArtist(artistData), trackCount });
      }
    });

    return artists;
  }

  async getArtist(artistId: string): Promise<Artist | null> {
    const [artistData, trackCount] = await Promise.all([
      redisClient.hGetAll(this.key("artist", artistId)),
      redisClient.sCard(this.key("artist", artistId, "tracks")),
    ]);

    if (!isNonEmptyHash(artistData)) return null;

    return { ...convertFromRedisArtist(artistData), trackCount };
  }

  async getPlaylistData(playlistId: string): Promise<PlaylistData | null> {
    const playlist = await this.getPlaylist(playlistId);
    if (!playlist) return null;

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

    const uniqueArtistIds = Array.from(artistTrackCount.keys());
    const artistPipeline = redisClient.multi();
    uniqueArtistIds.forEach((artistId) =>
      artistPipeline.hGetAll(this.key("artist", artistId)),
    );
    const artistResults = (await artistPipeline.exec()) as unknown as RedisHash[];

    const artists: Artist[] = [];
    const artistGenres = new Map<string, Set<string>>();

    artistResults.forEach((data, index) => {
      if (!isNonEmptyHash(data)) return;
      const artist = convertFromRedisArtist(data);
      const trackCount = artistTrackCount.get(uniqueArtistIds[index]) || 0;
      artists.push({ ...artist, trackCount });
      artistGenres.set(artist.id, new Set(artist.genres));
    });

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
