import {
  ArtistShare,
  DecadeShare,
  OwnershipBreakdown,
  PlaylistRanking,
  ReleaseDateCoverage,
  Track,
} from "@smart-music-library/shared";
import { LucideIcon, RefreshCw } from "lucide-react";
import { ReactNode, useState } from "react";
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
      <div className="card-body gap-4 p-5 flex flex-col">
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
  // Sized by its container, not the viewport, so the same tiles work full
  // width (one row) and in a narrow side column (compact two-column grid).
  return (
    <div className="@container w-full">
      <div className="stats stats-vertical grid-cols-2 @xl:stats-horizontal @xl:grid-cols-none bg-base-100 border border-base-200 shadow-sm w-full overflow-x-auto @max-xl:[&_.stat]:px-4 @max-xl:[&_.stat]:py-3 @max-xl:[&_.stat-value]:text-xl @max-xl:[&_.stat-figure_svg]:size-5">
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
    </div>
  );
}

type OwnershipKey = "owned" | "wishlist" | "notOwned";

const OWNERSHIP_SEGMENTS: {
  key: OwnershipKey;
  label: string;
  color: string;
}[] = [
  { key: "owned", label: "Owned", color: "var(--color-chart-owned)" },
  { key: "wishlist", label: "Wishlist", color: "var(--color-chart-wishlist)" },
  // Neutral remainder ring: identified by the legend label, not by hue.
  {
    key: "notOwned",
    label: "Not owned",
    color: "color-mix(in oklab, var(--color-base-content) 18%, transparent)",
  },
];

const DONUT_RADIUS = 40;
const DONUT_STROKE = 14;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
// Gap between segments, in viewBox units (≈2px at typical sizes).
const DONUT_GAP = 1.2;

export function OwnershipCard({
  ownership,
}: {
  ownership: OwnershipBreakdown;
}) {
  const [active, setActive] = useState<OwnershipKey | null>(null);
  const total = ownership.owned + ownership.wishlist + ownership.notOwned;

  const segments = OWNERSHIP_SEGMENTS.map((segment) => ({
    ...segment,
    count: ownership[segment.key],
    share: total > 0 ? ownership[segment.key] / total : 0,
  }));
  const visible = segments.filter((s) => s.count > 0);
  const gap = visible.length > 1 ? DONUT_GAP : 0;

  let offset = 0;
  const arcs = visible.map((segment) => {
    const length = segment.share * DONUT_CIRCUMFERENCE;
    const arc = {
      ...segment,
      dash: Math.max(0, length - gap),
      offset,
    };
    offset += length;
    return arc;
  });

  const focused = segments.find((s) => s.key === active);
  const centre = focused ?? {
    label: "owned",
    share: ownership.ownedShare,
    count: ownership.owned,
  };

  return (
    <StatCard title="Collection" className="h-full">
      <div className="flex flex-1 flex-col gap-5">
        <div className="flex flex-1 items-center justify-center">
          <div className="relative w-full max-w-72 aspect-square">
            <svg
              viewBox="0 0 100 100"
              className="size-full -rotate-90"
              role="img"
              aria-label={`${formatCount(ownership.owned)} owned, ${formatCount(
                ownership.wishlist,
              )} on wishlist, ${formatCount(ownership.notOwned)} not owned`}
            >
              {/* Track, so an empty or tiny share still reads as a ring */}
              <circle
                cx="50"
                cy="50"
                r={DONUT_RADIUS}
                fill="none"
                stroke="var(--color-base-200)"
                strokeWidth={DONUT_STROKE}
              />
              {arcs.map((arc) => (
                <circle
                  key={arc.key}
                  cx="50"
                  cy="50"
                  r={DONUT_RADIUS}
                  fill="none"
                  stroke={arc.color}
                  strokeWidth={
                    active === arc.key ? DONUT_STROKE + 3 : DONUT_STROKE
                  }
                  strokeDasharray={`${arc.dash} ${DONUT_CIRCUMFERENCE}`}
                  strokeDashoffset={-arc.offset}
                  className="cursor-default transition-[stroke-width,opacity] duration-150"
                  opacity={active && active !== arc.key ? 0.45 : 1}
                  onMouseEnter={() => setActive(arc.key)}
                  onMouseLeave={() => setActive(null)}
                >
                  <title>{`${arc.label}: ${formatCount(arc.count)} (${formatPercent(arc.share)})`}</title>
                </circle>
              ))}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-4xl font-bold tabular-nums leading-none">
                {formatPercent(centre.share)}
              </span>
              <span className="mt-1 text-sm text-base-content/60 lowercase">
                {centre.label}
              </span>
              <span className="text-xs text-base-content/50 tabular-nums">
                {formatCount(centre.count)} of {formatCount(total)}
              </span>
            </div>
          </div>
        </div>

        <ul className="grid grid-cols-3 gap-2 text-sm">
          {segments.map((segment) => (
            <li key={segment.key}>
              <button
                type="button"
                className={`w-full rounded-box px-2 py-1.5 text-left transition-colors ${
                  active === segment.key
                    ? "bg-base-200"
                    : "hover:bg-base-200/60"
                }`}
                onMouseEnter={() => setActive(segment.key)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(segment.key)}
                onBlur={() => setActive(null)}
              >
                <span className="flex items-baseline gap-1.5 text-base-content/70 leading-tight">
                  <span
                    className="size-2.5 shrink-0 translate-y-px rounded-full"
                    style={{ background: segment.color }}
                    aria-hidden
                  />
                  <span>{segment.label}</span>
                </span>
                <span className="block font-semibold tabular-nums">
                  {formatCount(segment.count)}
                  <span className="ml-1 font-normal text-base-content/50">
                    {formatPercent(segment.share)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {ownership.wishlist > 0 && (
          <Link to="/wishlist" className="link link-primary text-xs -mt-2">
            View wishlist
          </Link>
        )}
      </div>
    </StatCard>
  );
}

function BarRow({
  label,
  value,
  share,
  max,
  to,
  ariaLabel,
}: {
  label: ReactNode;
  value: ReactNode;
  share: number;
  max: number;
  /** Makes the whole row (label, value and bar) a link. */
  to?: string;
  ariaLabel?: string;
}) {
  // Scale bars to the largest entry so small libraries still show contrast.
  const scaled = max > 0 ? (share / max) * 100 : 0;
  const content = (
    <>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="truncate min-w-0 transition-colors group-hover:text-primary">
          {label}
        </span>
        <span className="text-base-content/60 tabular-nums shrink-0">
          {value}
        </span>
      </div>
      <progress
        className="progress progress-primary w-full h-2"
        value={scaled}
        max={100}
      />
    </>
  );

  if (!to) {
    return <li className="flex flex-col gap-1">{content}</li>;
  }

  return (
    <li>
      <Link
        to={to}
        aria-label={ariaLabel}
        className="group -mx-2 flex flex-col gap-1 rounded-box px-2 py-1 transition-colors hover:bg-base-200/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {content}
      </Link>
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

// The sync modal lives in the navbar; open it from anywhere.
function openSyncModal() {
  (
    document.getElementById("syncModal") as HTMLDialogElement | null
  )?.showModal();
}

export function DecadesCard({
  decades,
  releaseDates,
  playlistId,
}: {
  decades: DecadeShare[];
  releaseDates: ReleaseDateCoverage;
  /** Scope decade links to this playlist. */
  playlistId?: string;
}) {
  const decadeLink = (decade: string) =>
    `/decades/${decade}${
      playlistId ? `?playlist=${encodeURIComponent(playlistId)}` : ""
    }`;
  const max = Math.max(0, ...decades.map((d) => d.share));
  const known = releaseDates.fromYouTube + releaseDates.fromMusicBrainz;
  const total = known + releaseDates.unknown;

  return (
    <StatCard
      title="Eras"
      action={
        releaseDates.lookupPending ? (
          <span className="badge badge-ghost badge-sm gap-1">
            <span className="loading loading-spinner loading-xs" />
            looking up
          </span>
        ) : undefined
      }
    >
      {releaseDates.needsResync ? (
        <div role="status" className="alert alert-info alert-soft items-start">
          <RefreshCw className="size-4 mt-0.5 shrink-0" />
          <div className="flex flex-col gap-2">
            <span className="text-sm">
              Release years are fetched during sync. Sync your library to see
              when your music came out.
            </span>
            <button
              type="button"
              className="btn btn-info btn-sm self-start"
              onClick={openSyncModal}
            >
              Sync now
            </button>
          </div>
        </div>
      ) : decades.length === 0 ? (
        <p className="text-sm text-base-content/60">
          {releaseDates.lookupPending
            ? "Looking up release years…"
            : "No release years found yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {decades.map(({ decade, count, share }) => (
            <BarRow
              key={decade}
              label={decade}
              value={`${formatCount(count)} · ${formatPercent(share)}`}
              share={share}
              max={max}
              to={decadeLink(decade)}
              ariaLabel={`${decade}: ${formatCount(count)} track${count === 1 ? "" : "s"}`}
            />
          ))}
        </ul>
      )}
      {total > 0 && !releaseDates.needsResync && (
        <p
          className="mt-auto text-xs text-base-content/60 tooltip tooltip-top text-left"
          data-tip={`${formatCount(releaseDates.fromYouTube)} from YouTube Music, ${formatCount(
            releaseDates.fromMusicBrainz,
          )} from MusicBrainz. Tracks with only an upload date are left out.`}
        >
          Release year known for {formatCount(known)} of {formatCount(total)}{" "}
          tracks ({formatPercent(known / total)})
          {releaseDates.lookupPending && releaseDates.unknown > 0
            ? ` · looking up ${formatCount(releaseDates.unknown)}…`
            : ""}
        </p>
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

export const compactNumber = (n: number) =>
  `${compactFormatter.format(n)} views`;
