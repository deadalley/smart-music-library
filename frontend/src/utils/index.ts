import { PlaylistType, TrackOwnership } from "@smart-music-library/shared";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";

dayjs.extend(duration);

export function getAppName(): string {
  return "Smart Music";
}

// YouTube Music's watch page starts playback straight away.
export function getListenUrl(trackId: string): string {
  return `https://music.youtube.com/watch?v=${encodeURIComponent(trackId)}`;
}

export function formatDuration(ms: number): string {
  const dur = dayjs.duration(ms);
  const hours = dur.hours();
  const minutes = dur.minutes();
  const seconds = dur.seconds();

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  } else {
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }
}

export const PLAYLIST_TYPES = [
  { value: PlaylistType.MOOD, label: "Mood" },
  { value: PlaylistType.GENRE, label: "Genre" },
  { value: PlaylistType.COLLECTION, label: "Collection" },
  { value: PlaylistType.ARTIST, label: "Artist" },
  { value: PlaylistType.OTHER, label: "Other" },
];

export const TRACK_OWNERSHIP_OPTIONS = [
  { value: TrackOwnership.NOT_OWNED, label: "Not Owned" },
  { value: TrackOwnership.WISHLIST, label: "Wishlist" },
  { value: TrackOwnership.OWNED, label: "Owned" },
];
