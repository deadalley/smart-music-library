import { useQuery } from "@tanstack/react-query";
import { Clock, Heart, Music, Timer, Users } from "lucide-react";
import { baseAPI } from "../../services/api";
import { formatDuration } from "../../utils";
import { Loading } from "../Loading";
import {
  DecadesCard,
  formatCount,
  formatListeningTime,
  formatPercent,
  OwnershipCard,
  PlaylistTableCard,
  StatTiles,
  TopArtistsCard,
} from "./StatsCards";

export function PlaylistStatistics({
  playlistId,
  open = true,
  onOpenChange,
}: {
  playlistId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const {
    data: stats,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["playlist-stats", playlistId],
    refetchInterval: (query) =>
      query.state.data?.releaseDates.lookupPending ? 15_000 : false,
    queryFn: async () => (await baseAPI.getPlaylistStats(playlistId)).data,
  });

  return (
    <details
      className="collapse collapse-arrow bg-base-200/60 border border-base-200"
      open={open}
      onToggle={(e) => onOpenChange?.(e.currentTarget.open)}
    >
      <summary className="collapse-title font-semibold">Statistics</summary>
      {/* Container queries: the cards lay out by the width this section
          gets (full width on small screens, a side column on large ones). */}
      <div className="collapse-content @container">
        {isLoading ? (
          <Loading size="sm" />
        ) : error || !stats ? (
          <p className="text-sm text-error">Couldn't load statistics.</p>
        ) : stats.trackCount === 0 ? (
          <p className="text-sm text-base-content/60">
            This playlist is empty.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <StatTiles
              tiles={[
                {
                  title: "Tracks",
                  value: formatCount(stats.trackCount),
                  Icon: Music,
                },
                {
                  title: "Duration",
                  value: formatListeningTime(stats.totalDurationMs),
                  Icon: Clock,
                },
                {
                  title: "Avg. length",
                  value: formatDuration(stats.averageDurationMs),
                  Icon: Timer,
                },
                {
                  title: "Artists",
                  value: formatCount(stats.uniqueArtistCount),
                  description:
                    stats.topArtists[0] &&
                    `${formatPercent(stats.topArtists[0].share)} by ${stats.topArtists[0].artist.name}`,
                  Icon: Users,
                },
                {
                  title: "Liked",
                  value: formatPercent(stats.likedShare),
                  description: `${formatCount(stats.likedCount)} liked songs`,
                  Icon: Heart,
                },
              ]}
            />
            <div className="grid gap-4 @2xl:grid-cols-2 @6xl:grid-cols-4">
              <OwnershipCard ownership={stats.ownership} />
              <TopArtistsCard artists={stats.topArtists} limit={5} />
              <DecadesCard
                decades={stats.decades}
                releaseDates={stats.releaseDates}
                playlistId={playlistId}
              />
              <PlaylistTableCard
                title="Overlaps with"
                valueHeader="Shared"
                emptyText="No tracks shared with other playlists."
                rows={stats.overlaps.map(
                  ({ playlist, sharedCount, share }) => ({
                    playlistId: playlist.id,
                    name: playlist.name,
                    value: formatCount(sharedCount),
                    detail: `(${formatPercent(share)})`,
                  }),
                )}
              />
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
