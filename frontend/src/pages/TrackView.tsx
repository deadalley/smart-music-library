import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarDays,
  Clock,
  Disc3,
  ExternalLink,
  Eye,
  Heart,
  ListMusic,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Empty } from "../components/Empty";
import { Error } from "../components/Error";
import { PageLoading } from "../components/Loading";
import { Page } from "../components/Page";
import { PlaylistCollection } from "../components/PlaylistCollection";
import { SourceLink } from "../components/SourceLink";
import { compactNumber } from "../components/stats/StatsCards";
import { Tooltip } from "../components/Tooltip";
import { TrackOwnershipSelector } from "../components/TrackOwnershipSelector";
import { useSettings } from "../contexts/SettingsContext";
import { baseAPI } from "../services/api";
import { formatDuration, getListenUrl } from "../utils";
import { buildLinks } from "../utils/buyLinks";

/** One track: details, artist links, and every playlist it's in. */
export function TrackView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { enabledServices } = useSettings();

  const { data, isLoading, error } = useQuery({
    queryKey: ["track", id],
    queryFn: async () => (await baseAPI.getTrackDetails(id!)).data,
    enabled: !!id,
  });

  if (isLoading) return <PageLoading />;
  if (error || !data) {
    return <Error>Failed to load track. Please try again.</Error>;
  }

  const { track, playlists, liked } = data;
  const cover = track.album.images?.[0]?.url;
  const year = track.album.releaseDate?.substring(0, 4);
  // Only the upload date is known for some YouTube tracks: say so.
  const uploadOnly = track.album.releaseDateSource === "upload";
  const buyLinks = buildLinks({
    entityType: "track",
    name: track.name,
    artistName: track.artistNames[0],
    services: enabledServices,
  });

  return (
    <Page>
      <div className="mb-6">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft className="size-4 mr-2" />
          Back
        </button>
      </div>

      <Page.Header
        title={
          <div className="flex items-center gap-4">
            <div className="size-20 sm:size-24 rounded-lg overflow-hidden shrink-0 bg-base-200 flex items-center justify-center">
              {cover ? (
                <img
                  src={cover}
                  alt=""
                  className="w-full h-full object-cover"
                />
              ) : (
                <Disc3 className="size-10 text-base-content/30" />
              )}
            </div>
            <div className="flex flex-col gap-1 min-w-0">
              <span className="break-words">{track.name}</span>
              <span className="text-base font-normal text-base-content/70">
                {track.artistNames.map((name, i) => (
                  <span key={track.artistIds[i] ?? name}>
                    {i > 0 && ", "}
                    <Link
                      to={`/artists/${encodeURIComponent(track.artistIds[i])}`}
                      className="link link-hover hover:text-primary"
                    >
                      {name}
                    </Link>
                  </span>
                ))}
              </span>
            </div>
          </div>
        }
        action={<SourceLink href={track.externalUrls.spotify} />}
        subtitle={
          <div className="flex flex-wrap gap-x-4 gap-y-2 items-center mt-2">
            {year && (
              <span
                className="flex gap-2 items-center"
                title={
                  uploadOnly
                    ? "Upload year — the original release year isn't known"
                    : track.album.releaseDateSource === "musicbrainz"
                      ? "Release year from MusicBrainz"
                      : "Release year"
                }
              >
                <CalendarDays size={16} />
                {year}
                {uploadOnly && <span className="text-xs">(uploaded)</span>}
              </span>
            )}
            <span className="flex gap-2 items-center">
              <Clock size={16} />
              {formatDuration(track.durationMs)}
            </span>
            {track.popularity > 0 && (
              <span className="flex gap-2 items-center">
                <Eye size={16} />
                {compactNumber(track.popularity)}
              </span>
            )}
            {liked && (
              <Link
                to="/saved-tracks"
                className="badge badge-soft badge-primary gap-1"
              >
                <Heart size={12} fill="currentColor" />
                Liked
              </Link>
            )}
          </div>
        }
      />

      <div className="mb-8 flex flex-wrap items-center gap-2">
        <a
          href={getListenUrl(track.id)}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary btn-sm"
        >
          <ExternalLink className="size-4" />
          Listen
        </a>
        <div className="flex items-center gap-2 rounded-field border border-base-200 px-2 py-1">
          <span className="text-sm text-base-content/60">Collection</span>
          <TrackOwnershipSelector
            trackId={track.id}
            currentOwnership={track.ownership}
          />
        </div>
        {buyLinks.map((link) => (
          <Tooltip key={link.service} content={`Search on ${link.label}`}>
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-outline btn-sm"
            >
              <img src={link.icon} alt="" className="size-4 mr-2 rounded-sm" />
              {link.label}
            </a>
          </Tooltip>
        ))}
      </div>

      <h2 className="text-lg font-semibold mb-4">
        In {playlists.length} playlist{playlists.length === 1 ? "" : "s"}
      </h2>
      {playlists.length === 0 ? (
        <Empty Icon={ListMusic} size="sm">
          Not in any playlist yet
        </Empty>
      ) : (
        <PlaylistCollection playlists={playlists} />
      )}
    </Page>
  );
}
