import {
  Album,
  AppUser,
  Artist,
  LibrarySearchResult,
  LibraryStats,
  PersistResponse,
  Playlist,
  PlaylistAnalysisResult,
  PlaylistStats,
  Track,
  TrackAggregationResult,
} from "@smart-music-library/shared";
import axios from "axios";

const api = axios.create({
  baseURL: "/api",
  withCredentials: true,
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getCookie(name: string): string | null {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${escapeRegExp(name)}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

api.interceptors.request.use((config) => {
  const csrf = getCookie("csrf_token");
  if (csrf) {
    config.headers = config.headers ?? {};
    config.headers["X-CSRF-Token"] = csrf;
  }
  return config;
});

// Auth endpoints
export const authAPI = {
  login: () => {
    window.location.href = "/api/auth/youtube/login";
  },
  logout: () => api.post("/auth/youtube/logout"),
  getUser: () => api.get<AppUser>("/auth/me"),
};

export interface SyncStatusResponse {
  success: boolean;
  hasActiveJob: boolean;
  hasData: boolean;
  dataExpired: boolean;
  lastSync?: string;
  lastSyncedAt?: string;
  stats?: {
    playlists: number;
    tracks: number;
    artists: number;
    skippedPlaylists?: number;
  };
  lastJob?: {
    jobId: string;
    status: "waiting" | "active" | "completed" | "failed";
    error?: string;
    completedAt?: string;
  };
  // Present when hasActiveJob is true
  jobId?: string;
  status?: "waiting" | "active" | "completed" | "failed";
  progress?: number;
  message?: string;
  error?: string;
}

// Base api endpoints
export const baseAPI = {
  // Data persistence
  persist: () => api.post<PersistResponse>("/persist"),
  getSyncStatus: () => api.get<SyncStatusResponse>("/persist/status"),
  deleteData: () => api.delete("/persist"),

  // Analysis and aggregation
  analyzePlaylist: (playlistId: string) =>
    api.get<PlaylistAnalysisResult>(`/playlists/${playlistId}/analyze`),

  // Tracks
  getTracks: () => api.get<Track[]>("/tracks"),

  // Playlists
  getPlaylists: () => api.get<Playlist[]>("/playlists"),
  getPlaylist: (playlistId: string) =>
    api.get<Playlist>(`/playlists/${playlistId}`),
  getPlaylistTracks: (playlistId: string) =>
    api.get<Track[]>(`/playlists/${playlistId}/tracks`),
  addTrackToPlaylist: (playlistId: string, trackId: string) =>
    api.post(`/playlists/${playlistId}/tracks`, { trackId }),

  // Artists
  getArtists: () => api.get<Artist[]>("/artists"),
  getArtist: (artistId: string) => api.get<Artist>(`/artists/${artistId}`),
  getArtistTracks: (artistId: string) =>
    api.get<Track[]>(`/artists/${artistId}/tracks`),

  // Albums
  getAlbum: (albumId: string) => api.get<Album>(`/albums/${albumId}`),
  getAlbumTracks: (albumId: string) =>
    api.get<Track[]>(`/albums/${albumId}/tracks`),

  // Saved tracks
  getSavedTracks: () => api.get<Track[]>("/tracks/saved"),
  getAggregatedLikedSongs: () =>
    api.get<TrackAggregationResult[]>("/tracks/aggregate"),
  unlikeTrack: (trackId: string) => api.delete(`/tracks/saved/${trackId}`),

  // Playlist type management
  updatePlaylistType: (playlistId: string, playlistType: string) =>
    api.patch(`/playlists/${playlistId}/type`, { playlistType }),

  // Track ownership management
  updateTrackOwnership: (trackId: string, ownership: string) =>
    api.patch(`/tracks/${trackId}/ownership`, { ownership }),
  getTrackPlaylistMemberships: (trackIds: string[]) =>
    api.post<Record<string, string[]>>("/tracks/playlist-memberships", {
      trackIds,
    }),

  // Statistics
  getLibraryStats: () => api.get<LibraryStats>("/stats"),
  getPlaylistStats: (playlistId: string) =>
    api.get<PlaylistStats>(
      `/playlists/${encodeURIComponent(playlistId)}/stats`,
    ),

  getDecadeTracks: (decade: string, playlistId?: string) =>
    api.get<Track[]>(`/decades/${encodeURIComponent(decade)}/tracks`, {
      params: playlistId ? { playlist: playlistId } : undefined,
    }),

  // Library search
  search: (query: string) =>
    api.get<LibrarySearchResult>("/search", { params: { q: query } }),
};

// The backend transparently refreshes an expired YouTube access token on
// protected routes, so a 401 here means the session is actually dead (no
// valid refresh token either). Send the user back to the login screen
// instead of leaving the app stuck on empty/broken data.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    const url = error?.config?.url as string | undefined;
    const isAuthRoute = typeof url === "string" && url.startsWith("/auth/");

    if (status === 401 && !isAuthRoute && window.location.pathname !== "/login") {
      window.location.href = "/login";
    }

    return Promise.reject(error);
  },
);

/** Best human-readable message from an API error response. */
export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { message?: string; error?: string }
      | undefined;
    return data?.message || data?.error || fallback;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
