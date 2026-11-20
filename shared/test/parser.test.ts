import { describe, expect, it } from "vitest";
import {
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
  safeJsonParse,
} from "../src/parser";
import {
  Album,
  Artist,
  Playlist,
  PlaylistType,
  Track,
  TrackOwnership,
} from "../src/types";

const album: Album = {
  id: "ch1:v1",
  name: "Artist",
  type: "youtube",
  releaseDate: "2020-05-01",
  releaseDateSource: "youtube",
  images: [{ url: "https://img/1.jpg", width: 10, height: 10 }],
  externalUrls: { spotify: "https://youtube.com/channel/ch1" },
};

const track: Track = {
  id: "v1",
  name: "Song",
  uri: "youtube:video:v1",
  durationMs: 1234,
  explicit: false,
  popularity: 99,
  previewUrl: null,
  trackNumber: 0,
  discNumber: 0,
  playlistPosition: 3,
  externalUrls: { spotify: "https://youtube.com/watch?v=v1" },
  artistIds: ["ch1"],
  artistNames: ["Artist"],
  album,
  ownership: TrackOwnership.NOT_OWNED,
};

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('["a"]', [] as string[])).toEqual(["a"]);
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });

  it("returns the fallback for missing or corrupt input", () => {
    expect(safeJsonParse(undefined, [])).toEqual([]);
    expect(safeJsonParse("", [])).toEqual([]);
    expect(safeJsonParse("{not json", [])).toEqual([]);
    expect(safeJsonParse("null", { x: 1 })).toEqual({ x: 1 });
  });

  it("returns the fallback when the shape doesn't match", () => {
    expect(safeJsonParse('{"a":1}', [] as unknown[])).toEqual([]);
    expect(safeJsonParse("[1]", {})).toEqual({});
    expect(safeJsonParse('"str"', [] as unknown[])).toEqual([]);
  });
});

describe("track conversion", () => {
  it("round-trips through the Redis representation", () => {
    const stored = convertToRedisTrack(track);
    expect(stored).not.toHaveProperty("ownership");
    expect(convertFromRedisTrack(stored, album)).toEqual(track);
  });

  it("survives corrupt JSON fields instead of throwing", () => {
    const stored = { ...convertToRedisTrack(track), artistIds: "[oops" };
    const parsed = convertFromRedisTrack(stored, album);
    expect(parsed.artistIds).toEqual([]);
    expect(parsed.artistNames).toEqual(["Artist"]);
  });

  it("reads legacy ownership and ignores invalid values", () => {
    const stored = convertToRedisTrack(track);
    expect(
      convertFromRedisTrack({ ...stored, ownership: "owned" }).ownership,
    ).toBe(TrackOwnership.OWNED);
    expect(
      convertFromRedisTrack({ ...stored, ownership: "bogus" }).ownership,
    ).toBe(TrackOwnership.NOT_OWNED);
  });

  it("keeps the album id when the album hash is missing", () => {
    const parsed = convertFromRedisTrack(convertToRedisTrack(track));
    expect(parsed.album.id).toBe(album.id);
  });
});

describe("playlist / artist / album conversion", () => {
  it("round-trips a playlist (without the annotation)", () => {
    const playlist: Playlist = {
      id: "p1",
      name: "Mix",
      description: "desc",
      ownerId: "u1",
      public: false,
      collaborative: true,
      trackCount: 12,
      images: [],
      externalUrls: { spotify: "https://youtube.com/playlist?list=p1" },
      snapshotId: "",
      playlistType: PlaylistType.MOOD,
    };
    const stored = convertToRedisPlaylist(playlist);
    expect(stored).not.toHaveProperty("playlistType");
    expect(convertFromRedisPlaylist(stored)).toEqual({
      ...playlist,
      playlistType: undefined,
    });
  });

  it("round-trips an artist", () => {
    const artist: Artist = {
      id: "ch1",
      name: "Artist",
      images: [],
      externalUrls: { spotify: "" },
      trackCount: 2,
      genres: ["rock"],
    };
    expect(convertFromRedisArtist(convertToRedisArtist(artist))).toEqual(
      artist,
    );
  });

  it("round-trips an album", () => {
    expect(convertFromRedisAlbum(convertToRedisAlbum(album))).toEqual(album);
  });

  it("treats legacy album dates (no source) as upload dates", () => {
    const { releaseDateSource: _omit, ...legacy } = album;
    void _omit;
    const stored = convertToRedisAlbum(legacy);
    expect(convertFromRedisAlbum(stored).releaseDateSource).toBe("upload");
    expect(
      convertFromRedisAlbum({ ...stored, releaseDate: "" }).releaseDateSource,
    ).toBeUndefined();
  });
});

describe("type guards", () => {
  it("validates playlist types and ownership states", () => {
    expect(isPlaylistType("genre")).toBe(true);
    expect(isPlaylistType("nope")).toBe(false);
    expect(isTrackOwnership("wishlist")).toBe(true);
    expect(isTrackOwnership(undefined)).toBe(false);
  });
});
