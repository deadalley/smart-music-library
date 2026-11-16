import { describe, expect, it } from "vitest";
import { matches, SearchService } from "../src/services/SearchService";
import type { RedisService } from "../src/services/RedisService";
import { makeArtist, makeTrack } from "./fixtures";

describe("matches", () => {
  it("matches tokens spread across fields", () => {
    expect(matches(["daft", "around"], "Around the World", "Daft Punk")).toBe(true);
    expect(matches(["daft", "harder"], "Around the World", "Daft Punk")).toBe(false);
  });
});

describe("SearchService", () => {
  const library = {
    getUserTracks: async () => [
      makeTrack("t1", { name: "Around the World", artistNames: ["Daft Punk"] }),
      makeTrack("t2", {
        name: "Video",
        album: { id: "ch:t2", name: "Daft Punk", type: "youtube" },
      }),
    ],
    getUserArtists: async () => [makeArtist("a1", [])],
    getUserPlaylists: async () => [
      { id: "liked-songs", name: "Daft liked" },
      { id: "p1", name: "Daft mix" },
    ],
  } as unknown as RedisService;

  it("searches tracks by artist + title and skips fake YouTube albums and Liked Songs", async () => {
    const result = await new SearchService(library).search("daft world");
    expect(result.tracks.items.map((t) => t.id)).toEqual(["t1"]);

    const albums = await new SearchService(library).search("daft");
    expect(albums.albums.items).toEqual([]);
    expect(albums.playlists.items.map((p) => p.id)).toEqual(["p1"]);
  });
});
