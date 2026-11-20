import type {
  YouTubeService,
  YouTubeVideo,
} from "../src/services/YouTubeService";

export function video(id: string, channel = "ch1", categoryId = "10"): YouTubeVideo {
  return {
    id,
    title: `Song ${id}`,
    channelId: channel,
    channelTitle: `${channel} - Topic`,
    publishedAt: "2015-06-01T00:00:00Z",
    durationMs: 200_000,
    thumbnails: { default: { url: `https://img/${id}.jpg` } },
    viewCount: 10,
    categoryId,
  };
}

export type FakeLibrary = {
  liked: YouTubeVideo[];
  playlists: { id: string; title: string; videos: YouTubeVideo[] }[];
  failPlaylist?: { id: string; status: number };
  failChannels?: boolean;
};

export function fakeYouTube(lib: FakeLibrary): YouTubeService {
  const all = new Map<string, YouTubeVideo>();
  lib.liked.forEach((v) => all.set(v.id, v));
  lib.playlists.forEach((p) => p.videos.forEach((v) => all.set(v.id, v)));
  const videoLookups: string[][] = [];

  return {
    videoLookups,
    listLikedVideos: async () => lib.liked,
    listMyPlaylists: async () =>
      lib.playlists.map((p) => ({
        id: p.id,
        title: p.title,
        description: "",
        itemCount: p.videos.length,
        thumbnails: null,
      })),
    listPlaylistVideoIds: async (playlistId: string) => {
      if (lib.failPlaylist?.id === playlistId) {
        throw Object.assign(new Error("nope"), {
          response: { status: lib.failPlaylist.status },
        });
      }
      return lib.playlists.find((p) => p.id === playlistId)!.videos.map((v) => v.id);
    },
    getVideosByIds: async (ids: string[]) => {
      videoLookups.push(ids);
      return ids.map((id) => all.get(id)!).filter(Boolean);
    },
    getChannelsByIds: async (ids: string[]) => {
      if (lib.failChannels) {
        throw Object.assign(new Error("upstream down"), {
          response: { status: 500 },
        });
      }
      return ids.map((id) => ({ id, thumbnails: null }));
    },
  } as unknown as YouTubeService;
}
