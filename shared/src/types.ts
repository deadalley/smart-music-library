// Base types
// Shape returned by GET /api/auth/me
export interface AppUser {
  id: string;
  display_name: string;
}

export interface Image {
  url: string;
  height?: number;
  width?: number;
}

// NOTE: the `spotify` key is a legacy name kept for compatibility with data
// already stored in Redis; it holds the YouTube / YouTube Music URL.
export interface ExternalUrls {
  spotify: string;
}

export enum PlaylistType {
  MOOD = "mood",
  GENRE = "genre",
  COLLECTION = "collection",
  ARTIST = "artist",
  OTHER = "other",
}

export interface Playlist {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  public: boolean;
  collaborative: boolean;
  trackCount: number;
  images: Image[];
  externalUrls: ExternalUrls;
  snapshotId: string;
  playlistType?: PlaylistType;
}

export enum TrackOwnership {
  NOT_OWNED = "not-owned",
  WISHLIST = "wishlist",
  OWNED = "owned",
}

export interface Track {
  id: string;
  name: string;
  uri: string;
  durationMs: number;
  explicit: boolean;
  popularity: number;
  previewUrl: string | null;
  trackNumber: number;
  discNumber: number;
  playlistPosition?: number; // Position in the playlist (0-based index)
  externalUrls: ExternalUrls;
  artistIds: string[];
  artistNames: string[];
  album: Album;
  ownership: TrackOwnership;
}

export interface Artist {
  id: string;
  name: string;
  images: Image[];
  externalUrls: ExternalUrls;
  trackCount: number;
  genres: string[];
}

// Where an album's releaseDate came from: the YouTube Music description
// ("Released on" / ℗), a MusicBrainz lookup, or just the video upload date.
export type ReleaseDateSource = "youtube" | "musicbrainz" | "upload";

export interface Album {
  id: string;
  name: string;
  type: string;
  releaseDate?: string;
  releaseDateSource?: ReleaseDateSource;
  totalTracks?: number;
  images?: Image[];
  externalUrls?: ExternalUrls;
}

// Response types
export interface PersistResponse {
  success: boolean;
  message: string;
  jobId?: string;
  status?: string;
  stats?: {
    playlists: number;
    tracks: number;
    artists: number;
    user_id: string;
  };
}

// Aggregation types
export interface GenreOutlier {
  artist: Artist;
  trackCount: number;
  artistGenres: string[];
  deviationScore: number; // 0-100, higher means more outlier
  commonGenres: string[]; // Genres this artist shares with the playlist
  uniqueGenres: string[]; // Genres this artist has that are uncommon in playlist
}

export interface DecadeDistribution {
  decade: string; // e.g., "1960s", "1970s"
  count: number;
  percentage: number;
}

export interface TimeOutlier {
  track: Track;
  releaseYear: number;
  deviationYears: number; // How many years away from median
}

export interface PlaylistConsistencyAnalysis {
  consistencyScore: number; // 0-100, higher is more consistent
  genreScore?: number; // 0-100, genre-only consistency (optional)
  timeScore?: number; // 0-100, time-only consistency (optional)
  outliers: GenreOutlier[];
  mainGenres: string[]; // Top 5-10 most common genres
  totalArtists: number;
  timeAnalysis?: {
    medianYear: number;
    q1Year?: number;
    q3Year?: number;
    iqrYears?: number;
    outlierBounds?: { lower: number; upper: number };
    yearRange: { min: number; max: number };
    decadeDistribution: DecadeDistribution[];
    timeOutliers: TimeOutlier[];
  };
}

export interface PlaylistData {
  playlist: Playlist;
  tracks: Track[];
  artists: Artist[];
  genres: { name: string; count: number }[];
  totalDurationMs: number;
}

export interface TrackAggregationResult {
  track: Track;
  currentPlaylists: Playlist[];
  suggestedPlaylists: {
    playlist: Playlist;
    similarGenres: { name: string; count: number }[];
    similarArtists: (Artist & { tracks: { id: string; name: string }[] })[];
  }[];
}

export interface PlaylistAnalysisResult extends PlaylistData {
  consistencyAnalysis?: PlaylistConsistencyAnalysis;
}

export interface SearchResultGroup<T> {
  items: T[];
  totalCount: number;
}

export interface LibrarySearchResult {
  tracks: SearchResultGroup<Track>;
  albums: SearchResultGroup<Album & { artistName: string | null }>;
  artists: SearchResultGroup<Artist>;
  playlists: SearchResultGroup<Playlist>;
}

// Statistics
export interface ArtistShare {
  artist: Artist;
  trackCount: number;
  share: number; // 0-1, of the tracks considered
}

export interface DecadeShare {
  decade: string; // e.g. "2010s"
  count: number;
  share: number; // 0-1, of tracks with a known year
}

export interface OwnershipBreakdown {
  owned: number;
  wishlist: number;
  notOwned: number;
  ownedShare: number; // 0-1
}

export interface TrackStats {
  trackCount: number;
  totalDurationMs: number;
  averageDurationMs: number;
  longestTrack: Track | null;
  shortestTrack: Track | null;
  uniqueArtistCount: number;
  topArtists: ArtistShare[];
  ownership: OwnershipBreakdown;
  decades: DecadeShare[]; // real release dates only
  releaseDates: ReleaseDateCoverage;
  mostViewed: Track[];
}

export interface PlaylistRanking {
  playlist: Playlist;
  trackCount: number;
  totalDurationMs: number;
}

export interface ReleaseDateCoverage {
  fromYouTube: number;
  fromMusicBrainz: number;
  unknown: number; // only the upload date is known
  lookupPending: boolean;
}

export interface LibraryStats extends TrackStats {
  playlistCount: number;
  artistCount: number;
  likedCount: number;
  unsortedLikedCount: number; // liked songs that are in no playlist
  multiPlaylistTrackCount: number; // tracks in 2+ playlists
  averagePlaylistTrackCount: number;
  playlistsByType: { type: PlaylistType | "untyped"; count: number }[];
  largestPlaylists: PlaylistRanking[];
  longestPlaylists: PlaylistRanking[];
  lastSync?: string;
}

export interface PlaylistOverlap {
  playlist: Playlist;
  sharedCount: number;
  share: number; // 0-1, of this playlist's tracks
}

export interface PlaylistStats extends TrackStats {
  likedCount: number;
  likedShare: number; // 0-1
  overlaps: PlaylistOverlap[];
}
