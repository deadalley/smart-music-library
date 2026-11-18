import {
  ArtistShare,
  DecadeShare,
  OwnershipBreakdown,
  PlaylistRanking,
  Track,
} from "@smart-music-library/shared";
import { LucideIcon } from "lucide-react";
import { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatDuration } from "../../utils";

export const formatPercent = (share: number) => `${Math.round(share * 100)}%`;

export const formatCount = (n: number) => n.toLocaleString();

/** Long durations read better as "12 h 5 min" than "12:05:00". */
export function formatListeningTime(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (hours < 24) return `${hours} h ${minutes} min`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

export function StatCard({
  title,
  action,
  children,
  className = "",
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`card bg-base-100 border border-base-200 shadow-sm ${className}`}
    >
      <div className="card-body gap-4 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="card-title text-base">{title}</h2>
          {action}
        </div>
        {children}
      </div>
    </div>
  );
}

export type StatTile = {
  title: string;
  value: ReactNode;
  description?: ReactNode;
  Icon?: LucideIcon;
  to?: string;
};

export function StatTiles({ tiles }: { tiles: StatTile[] }) {
  return (
    <div className="stats stats-vertical sm:stats-horizontal bg-base-100 border border-base-200 shadow-sm w-full overflow-x-auto">
      {tiles.map(({ title, value, description, Icon, to }) => {
        const content = (
          <>
            {Icon && (
              <div className="stat-figure text-primary">
                <Icon className="size-7" />
              </div>
            )}
            <div className="stat-title">{title}</div>
            <div className="stat-value text-2xl lg:text-3xl tabular-nums">
              {value}
            </div>
            {description && <div className="stat-desc">{description}</div>}
          </>
        );
        return to ? (
          <Link
            key={title}
            to={to}
            className="stat hover:bg-base-200/60 transition-colors"
          >
            {content}
          </Link>
        ) : (
          <div key={title} className="stat">
            {content}
          </div>
        );
      })}
    </div>
  );
}

export function OwnershipCard({
  ownership,
}: {
  ownership: OwnershipBreakdown;
}) {
  const percent = Math.round(ownership.ownedShare * 100);
  return (
    <StatCard title="Collection">
      <div className="flex items-center gap-6">
        <div
          className="radial-progress text-primary bg-base-200 shrink-0"
          style={
            {
              "--value": percent,
              "--size": "6.5rem",
              "--thickness": "0.6rem",
            } as CSSProperties
          }
          role="progressbar"
          aria-valuenow={percent}
          aria-label="Share of tracks owned"
        >
          <span className="text-xl font-bold text-base-content">
            {percent}%
          </span>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <span className="text-base-content/60">of tracks owned</span>
          <div className="flex flex-wrap gap-2">
            <span className="badge badge-success badge-soft">
              {formatCount(ownership.owned)} owned
            </span>
            <span className="badge badge-warning badge-soft">
              {formatCount(ownership.wishlist)} wishlist
            </span>
            <span className="badge badge-ghost">
              {formatCount(ownership.notOwned)} not owned
            </span>
          </div>
          {ownership.wishlist > 0 && (
            <Link to="/wishlist" className="link link-primary text-xs">
              View wishlist
            </Link>
          )}
        </div>
      </div>
    </StatCard>
  );
}

function BarRow({
  label,
  value,
  share,
  max,
}: {
  label: ReactNode;
  value: ReactNode;
  share: number;
  max: number;
}) {
  // Scale bars to the largest entry so small libraries still show contrast.
  const scaled = max > 0 ? (share / max) * 100 : 0;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="truncate min-w-0">{label}</span>
        <span className="text-base-content/60 tabular-nums shrink-0">
          {value}
        </span>
      </div>
      <progress
        className="progress progress-primary w-full h-2"
        value={scaled}
        max={100}
      />
    </li>
  );
}

export function TopArtistsCard({
  artists,
  limit = 10,
}: {
  artists: ArtistShare[];
  limit?: number;
}) {
  const shown = artists.slice(0, limit);
  const max = Math.max(0, ...shown.map((a) => a.share));
  return (
    <StatCard title="Top artists">
      {shown.length === 0 ? (
        <p className="text-sm text-base-content/60">No artists yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map(({ artist, trackCount, share }) => (
            <BarRow
              key={artist.id}
              label={
                <Link
                  to={`/artists/${encodeURIComponent(artist.id)}`}
                  className="hover:text-primary transition-colors"
                >
                  {artist.name}
                </Link>
              }
              value={`${formatCount(trackCount)} · ${formatPercent(share)}`}
              share={share}
              max={max}
            />
          ))}
        </ul>
      )}
    </StatCard>
  );
}

export function DecadesCard({ decades }: { decades: DecadeShare[] }) {
  const max = Math.max(0, ...decades.map((d) => d.share));
  return (
    <StatCard
      title="Eras"
      action={
        <span
          className="badge badge-ghost badge-sm tooltip tooltip-left"
          data-tip="YouTube only exposes when a video was uploaded, not the original release year."
        >
          by upload year
        </span>
      }
    >
      {decades.length === 0 ? (
        <p className="text-sm text-base-content/60">No dates available.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {decades.map(({ decade, count, share }) => (
            <BarRow
              key={decade}
              label={decade}
              value={`${formatCount(count)} · ${formatPercent(share)}`}
              share={share}
              max={max}
            />
          ))}
        </ul>
      )}
    </StatCard>
  );
}

export function PlaylistTableCard({
  title,
  rows,
  valueHeader,
  emptyText = "Nothing to show.",
}: {
  title: ReactNode;
  rows: {
    playlistId: string;
    name: string;
    value: ReactNode;
    detail?: ReactNode;
  }[];
  valueHeader: string;
  emptyText?: string;
}) {
  return (
    <StatCard title={title}>
      {rows.length === 0 ? (
        <p className="text-sm text-base-content/60">{emptyText}</p>
      ) : (
        <div className="overflow-x-auto -mx-2">
          <table className="table table-zebra table-sm">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th>Playlist</th>
                <th className="text-right">{valueHeader}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.playlistId} className="hover:bg-base-200/60">
                  <td className="text-base-content/50 tabular-nums">{i + 1}</td>
                  <td className="max-w-0 w-full">
                    <Link
                      to={`/playlists/${encodeURIComponent(row.playlistId)}`}
                      className="block truncate hover:text-primary transition-colors"
                      title={row.name}
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td className="text-right tabular-nums whitespace-nowrap">
                    {row.value}
                    {row.detail && (
                      <span className="text-base-content/50 ml-1">
                        {row.detail}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StatCard>
  );
}

export const rankingRows = (
  rankings: PlaylistRanking[],
  by: "tracks" | "duration",
) =>
  rankings.map(({ playlist, trackCount, totalDurationMs }) => ({
    playlistId: playlist.id,
    name: playlist.name,
    value:
      by === "tracks"
        ? formatCount(trackCount)
        : formatListeningTime(totalDurationMs),
  }));

export function TrackHighlightsCard({
  longestTrack,
  shortestTrack,
  mostViewed,
}: {
  longestTrack: Track | null;
  shortestTrack: Track | null;
  mostViewed: Track[];
}) {
  const highlight = (label: string, track: Track | null) =>
    track && (
      <li className="list-row items-center px-0">
        <span className="badge badge-ghost badge-sm">{label}</span>
        <span className="truncate min-w-0" title={track.name}>
          {track.name}
          <span className="text-base-content/50">
            {" "}
            · {track.artistNames.join(", ")}
          </span>
        </span>
        <span className="tabular-nums text-base-content/60">
          {formatDuration(track.durationMs)}
        </span>
      </li>
    );

  return (
    <StatCard title="Track highlights">
      <ul className="list">
        {highlight("Longest", longestTrack)}
        {highlight("Shortest", shortestTrack)}
      </ul>
      {mostViewed.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Most viewed</h3>
          <ol className="list">
            {mostViewed.map((track, i) => (
              <li key={track.id} className="list-row items-center px-0 py-2">
                <span className="text-base-content/50 tabular-nums w-4">
                  {i + 1}
                </span>
                <span className="truncate min-w-0" title={track.name}>
                  {track.name}
                  <span className="text-base-content/50">
                    {" "}
                    · {track.artistNames.join(", ")}
                  </span>
                </span>
                <span className="tabular-nums text-base-content/60 text-sm">
                  {compactNumber(track.popularity)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </StatCard>
  );
}

const compactFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export const compactNumber = (n: number) => `${compactFormatter.format(n)} views`;
