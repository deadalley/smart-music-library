import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Clock, Music } from "lucide-react";
import { useParams, useSearchParams } from "react-router-dom";
import { Empty } from "../components/Empty";
import { Error } from "../components/Error";
import { PageLoading } from "../components/Loading";
import { Page } from "../components/Page";
import { TrackList } from "../components/TrackList";
import { baseAPI } from "../services/api";
import { formatDuration } from "../utils";

/** Tracks released in one decade, library-wide or within one playlist. */
export function DecadeView() {
  const { decade = "" } = useParams<{ decade: string }>();
  const [searchParams] = useSearchParams();
  const playlistId = searchParams.get("playlist") ?? undefined;
  const label = decade.endsWith("s") ? decade : `${decade}s`;

  const {
    data: tracks,
    isLoading: isTracksLoading,
    error: tracksError,
  } = useQuery({
    queryKey: ["decade-tracks", decade, playlistId],
    queryFn: async () =>
      (await baseAPI.getDecadeTracks(decade, playlistId)).data,
    enabled: !!decade,
  });

  const { data: playlist, isLoading: isPlaylistLoading } = useQuery({
    queryKey: ["playlist", playlistId],
    queryFn: async () => (await baseAPI.getPlaylist(playlistId!)).data,
    enabled: !!playlistId,
  });

  if (isTracksLoading || (playlistId && isPlaylistLoading)) {
    return <PageLoading />;
  }

  if (tracksError || !tracks) {
    return (
      <Error>Failed to load tracks from the {label}. Please try again.</Error>
    );
  }

  const totalDurationMs = tracks.reduce((sum, t) => sum + t.durationMs, 0);

  return (
    <Page>
      {playlistId ? (
        <Page.Back
          to={`/playlists/${encodeURIComponent(playlistId)}`}
          label={playlist?.name ?? "Playlist"}
        />
      ) : (
        <Page.Back to="/statistics" label="Statistics" />
      )}
      <Page.Header
        title={playlist ? `${label} · ${playlist.name}` : label}
        subtitle={
          <div className="flex gap-2 items-center">
            <span className="flex gap-2 items-center justify-start text-base-content/60">
              <Music size={16} />
              {tracks.length} track{tracks.length !== 1 ? "s" : ""}
            </span>
            •
            <span className="flex gap-2 items-center justify-start text-base-content/60">
              <Clock size={16} />
              {formatDuration(totalDurationMs)}
            </span>
          </div>
        }
      />

      {tracks.length === 0 ? (
        <Empty Icon={CalendarDays}>No tracks from the {label}</Empty>
      ) : (
        <TrackList tracks={tracks} withOwnershipFilter />
      )}
    </Page>
  );
}
