import { useQuery } from "@tanstack/react-query";
import { Clock, Music } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Empty } from "../components/Empty";
import { Error } from "../components/Error";
import { PageLoading } from "../components/Loading";
import { Page } from "../components/Page";
import { PlaylistAnalysisResult } from "../components/PlaylistAnalysisResult";
import { PlaylistTypeSelector } from "../components/PlaylistTypeSelector";
import { SourceLink } from "../components/SourceLink";
import { PlaylistStatistics } from "../components/stats/PlaylistStatistics";
import { TrackList } from "../components/TrackList";
import { baseAPI } from "../services/api";
import { formatDuration } from "../utils";

export function PlaylistView() {
  const { id } = useParams<{ id: string }>();
  const [statsOpen, setStatsOpen] = useState(true);

  const {
    data: playlist,
    isLoading: isPlaylistLoading,
    error: playlistError,
  } = useQuery({
    queryKey: ["playlist", id],
    queryFn: async () => {
      const response = await baseAPI.getPlaylist(id!);
      return response.data;
    },
    enabled: !!id,
  });

  const {
    data: analysisResult,
    isLoading: isAnalysisLoading,
    error: analysisError,
  } = useQuery({
    queryKey: ["playlist-analysis", id],
    queryFn: async () => {
      const response = await baseAPI.analyzePlaylist(id!);
      return response.data;
    },
    enabled: !!id,
  });

  const isLoading = isPlaylistLoading || isAnalysisLoading;
  const error = playlistError || analysisError;

  if (isLoading) {
    return <PageLoading />;
  }

  if (error || !playlist || !analysisResult) {
    return <Error>Failed to load playlist tracks. Please try again.</Error>;
  }

  const { artists, genres, tracks, consistencyAnalysis } = analysisResult;

  return (
    <Page>
      <Page.Back to="/playlists" label="Playlists" />
      <Page.Header
        title={playlist?.name || "Playlist"}
        action={
          <div className="flex gap-2 items-center">
            <PlaylistTypeSelector
              playlistId={id!}
              currentType={playlist.playlistType}
            />
            <SourceLink href={playlist.externalUrls.spotify} />
          </div>
        }
        subtitle={
          <div className="flex gap-2 items-center">
            <span className="flex gap-2 items-center justify-start text-base-content/60">
              <Music size={16} />
              {tracks.length} track{tracks.length !== 1 ? "s" : ""}
            </span>
            •
            <span className="flex gap-2 items-center justify-start text-base-content/60">
              <Clock size={16} />
              {formatDuration(analysisResult.totalDurationMs)}
            </span>
          </div>
        }
      />

      {/* Large screens: tracks on the left, statistics in a sticky column on
          the right (folding the statistics gives the tracks the full width).
          Smaller screens: statistics first, then tracks, full width. */}
      <div
        className={`flex flex-col gap-6 ${
          statsOpen
            ? "xl:grid xl:grid-cols-[minmax(0,1fr)_24rem] 2xl:grid-cols-[minmax(0,1fr)_28rem] xl:items-start"
            : ""
        }`}
      >
        <aside
          className={`flex flex-col gap-4 min-w-0 ${
            statsOpen
              ? "xl:order-2 xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto"
              : ""
          }`}
        >
          <PlaylistStatistics
            playlistId={id!}
            open={statsOpen}
            onOpenChange={setStatsOpen}
          />

          {/* Genre/consistency analysis needs artist genres, which YouTube
              doesn't provide; only show it when there's something to show. */}
          {genres.length > 0 && (
            <PlaylistAnalysisResult
              artists={artists}
              genres={genres}
              consistencyAnalysis={consistencyAnalysis}
            />
          )}
        </aside>

        <div className="min-w-0 xl:order-1">
          {tracks.length === 0 ? (
            <Empty Icon={Music}>No tracks found</Empty>
          ) : (
            <TrackList tracks={tracks} withOwnershipFilter />
          )}
        </div>
      </div>
    </Page>
  );
}
