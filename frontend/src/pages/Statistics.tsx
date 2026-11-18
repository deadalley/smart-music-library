import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  BarChart3,
  Clock,
  Copy,
  Heart,
  HeartCrack,
  Hourglass,
  ListMusic,
  Music,
  Users,
} from "lucide-react";
import { Empty } from "../components/Empty";
import { Error } from "../components/Error";
import { PageLoading } from "../components/Loading";
import { Page } from "../components/Page";
import {
  DecadesCard,
  formatCount,
  formatListeningTime,
  formatPercent,
  OwnershipCard,
  PlaylistTableCard,
  rankingRows,
  StatCard,
  StatTiles,
  TopArtistsCard,
  TrackHighlightsCard,
} from "../components/stats/StatsCards";
import { baseAPI } from "../services/api";
import { formatDuration, PLAYLIST_TYPES } from "../utils";

dayjs.extend(relativeTime);

const TYPE_LABELS: Record<string, string> = Object.fromEntries(
  PLAYLIST_TYPES.map(({ value, label }) => [value, label]),
);

export function Statistics() {
  const { data: stats, isLoading, error } = useQuery({
    queryKey: ["library-stats"],
    queryFn: async () => (await baseAPI.getLibraryStats()).data,
  });

  if (isLoading) return <PageLoading />;
  if (error || !stats) {
    return <Error>Failed to load statistics. Please try again.</Error>;
  }

  if (stats.trackCount === 0) {
    return (
      <Page>
        <Page.Header title="Statistics" />
        <Empty Icon={BarChart3}>Sync your library to see statistics</Empty>
      </Page>
    );
  }

  const totalTyped = stats.playlistsByType.reduce((s, t) => s + t.count, 0);

  return (
    <Page>
      <Page.Header
        title="Statistics"
        subtitle={
          stats.lastSync
            ? `Based on your library as of ${dayjs(stats.lastSync).fromNow()}`
            : undefined
        }
      />

      <div className="flex flex-col gap-4">
        <StatTiles
          tiles={[
            {
              title: "Tracks",
              value: formatCount(stats.trackCount),
              description: `${formatCount(stats.uniqueArtistCount)} artists`,
              Icon: Music,
            },
            {
              title: "Playlists",
              value: formatCount(stats.playlistCount),
              Icon: ListMusic,
              to: "/playlists",
            },
            {
              title: "Artists",
              value: formatCount(stats.artistCount),
              Icon: Users,
              to: "/artists",
            },
            {
              title: "Liked songs",
              value: formatCount(stats.likedCount),
              Icon: Heart,
              to: "/saved-tracks",
            },
            {
              title: "Listening time",
              value: formatListeningTime(stats.totalDurationMs),
              description: `avg. ${formatDuration(stats.averageDurationMs)} per track`,
              Icon: Clock,
            },
          ]}
        />

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <OwnershipCard ownership={stats.ownership} />
          <TopArtistsCard artists={stats.topArtists} />
          <DecadesCard decades={stats.decades} />
        </div>

        <h2 className="text-lg font-semibold mt-4">Organization</h2>
        <StatTiles
          tiles={[
            {
              title: "Liked, not in a playlist",
              value: formatCount(stats.unsortedLikedCount),
              description:
                stats.likedCount > 0
                  ? `${formatPercent(stats.unsortedLikedCount / stats.likedCount)} of liked songs`
                  : undefined,
              Icon: HeartCrack,
              to: "/saved-tracks",
            },
            {
              title: "In 2+ playlists",
              value: formatCount(stats.multiPlaylistTrackCount),
              description: `${formatPercent(stats.multiPlaylistTrackCount / stats.trackCount)} of tracks`,
              Icon: Copy,
            },
            {
              title: "Avg. playlist size",
              value:
                stats.playlistCount > 0
                  ? formatCount(stats.averagePlaylistTrackCount)
                  : "—",
              description: "tracks per playlist",
              Icon: Hourglass,
            },
          ]}
        />

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <PlaylistTableCard
            title="Largest playlists"
            valueHeader="Tracks"
            rows={rankingRows(stats.largestPlaylists, "tracks")}
          />
          <PlaylistTableCard
            title="Longest playlists"
            valueHeader="Duration"
            rows={rankingRows(stats.longestPlaylists, "duration")}
          />
          <StatCard title="Playlists by type">
            {totalTyped === 0 ? (
              <p className="text-sm text-base-content/60">No playlists yet.</p>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {stats.playlistsByType.map(({ type, count }) => (
                    <span
                      key={type}
                      className={`badge badge-lg ${
                        type === "untyped" ? "badge-ghost" : "badge-primary badge-soft"
                      }`}
                    >
                      {type === "untyped" ? "No type" : TYPE_LABELS[type] ?? type}
                      <span className="font-semibold tabular-nums">{count}</span>
                    </span>
                  ))}
                </div>
                <p className="text-xs text-base-content/60">
                  Set a type from a playlist's page to organize your library.
                </p>
              </div>
            )}
          </StatCard>
          <TrackHighlightsCard
            longestTrack={stats.longestTrack}
            shortestTrack={stats.shortestTrack}
            mostViewed={stats.mostViewed}
          />
        </div>
      </div>
    </Page>
  );
}
