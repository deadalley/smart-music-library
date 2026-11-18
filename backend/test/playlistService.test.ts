import { describe, expect, it } from "vitest";
import { PlaylistService } from "../src/services/PlaylistService";
import type { RedisService } from "../src/services/RedisService";
import { makeArtist, makeTrack } from "./fixtures";

const service = new PlaylistService({} as RedisService);

describe("calculatePlaylistConsistency", () => {
  it("handles an empty playlist without NaN", () => {
    const result = service.calculatePlaylistConsistency([], [], 0, []);
    expect(result.consistencyScore).toBe(100);
    expect(result.outliers).toEqual([]);
    expect(Number.isNaN(result.genreScore)).toBe(false);
  });

  it("scores a single-genre playlist as fully consistent", () => {
    const tracks = [makeTrack("t1"), makeTrack("t2")];
    const artists = [makeArtist("a1", ["rock"], 2)];
    const result = service.calculatePlaylistConsistency(
      artists,
      [{ name: "rock", count: 2 }],
      2,
      tracks,
    );
    expect(result.genreScore).toBe(100);
    expect(result.outliers).toEqual([]);
    expect(result.mainGenres).toEqual(["rock"]);
  });

  it("flags an artist whose genres don't fit the playlist", () => {
    const tracks = Array.from({ length: 10 }, (_, i) =>
      makeTrack(`t${i}`, { artistIds: [i < 9 ? "a1" : "a2"] }),
    );
    const artists = [
      makeArtist("a1", ["death metal"], 9),
      makeArtist("a2", ["k-pop"], 1),
    ];
    const result = service.calculatePlaylistConsistency(
      artists,
      [
        { name: "death metal", count: 9 },
        { name: "k-pop", count: 1 },
      ],
      10,
      tracks,
    );
    expect(result.outliers.map((o) => o.artist.id)).toEqual(["a2"]);
  });

  it("detects release-year outliers", () => {
    const tracks = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeTrack(`t${i}`, {
          album: { id: `al${i}`, name: "", type: "album", releaseDate: `199${i}-01-01` },
        }),
      ),
      makeTrack("old", {
        album: { id: "alold", name: "", type: "album", releaseDate: "1955-01-01" },
      }),
    ];
    const result = service.calculatePlaylistConsistency([], [], tracks.length, tracks);
    expect(result.timeAnalysis?.timeOutliers.map((o) => o.track.id)).toEqual(["old"]);
  });
});
