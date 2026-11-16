import { Artist, Track, TrackOwnership } from "@smart-music-library/shared";

export function makeTrack(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    name: `Track ${id}`,
    uri: `youtube:video:${id}`,
    durationMs: 180_000,
    explicit: false,
    popularity: 0,
    previewUrl: null,
    trackNumber: 0,
    discNumber: 0,
    externalUrls: { spotify: "" },
    artistIds: ["a1"],
    artistNames: ["Artist One"],
    album: {
      id: `album-${id}`,
      name: "Album",
      type: "album",
      releaseDate: "2000-01-01",
      images: [],
      externalUrls: { spotify: "" },
    },
    ownership: TrackOwnership.NOT_OWNED,
    ...overrides,
  };
}

export function makeArtist(id: string, genres: string[], trackCount = 1): Artist {
  return {
    id,
    name: `Artist ${id}`,
    images: [],
    externalUrls: { spotify: "" },
    trackCount,
    genres,
  };
}
