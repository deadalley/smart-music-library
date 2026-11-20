<div align="center">
   <img src="./assets/images/smart-music-library.svg" alt="Smart Music Library Logo" width="200"/>
  <h1>Smart Music Library</h1>
  <p>Smart playlist manager for your YouTube Music library.</p>
  
  [![React](https://img.shields.io/badge/React-18-61DAFB.svg)](https://react.dev)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6.svg)](https://www.typescriptlang.org)
  [![Node.js](https://img.shields.io/badge/Node.js-24-339933.svg)](https://nodejs.org)
  [![Express](https://img.shields.io/badge/Express-4-000000.svg)](https://expressjs.com)
  [![Redis](https://img.shields.io/badge/Redis-7-DC382D.svg)](https://redis.io)
</div>

---

## Screenshots

<img src="./assets/images/preview-4.png" alt="Saved Tracks" width="800"/>

<details>
<summary>View more</summary>
<img src="./assets/images/preview-1.png" alt="Playlists View" width="800"/>
<img src="./assets/images/preview-2.png" alt="Playlist Analysis" width="800"/>
<img src="./assets/images/preview-3.png" alt="Artists View" width="800"/>
</details>

## Prerequisites

- Node.js (v24 or higher)
- pnpm
- Redis
- A Google Cloud project with the YouTube Data API v3 enabled

## Local development

Create env file:

```env
# Backend
PORT=3001
CLIENT_URL=http://127.0.0.1:5173
NODE_ENV=development

# Signs the session cookie (required in production, >= 32 chars):
#   openssl rand -hex 32
COOKIE_SECRET=

# YouTube (Google) OAuth
# Enable "YouTube Data API v3" and create an OAuth Client ID (Web).
YOUTUBE_CLIENT_ID=your_google_oauth_client_id
YOUTUBE_CLIENT_SECRET=your_google_oauth_client_secret
YOUTUBE_REDIRECT_URI=http://127.0.0.1:3001/api/auth/youtube/callback

# Redis (optional; defaults to localhost:6379 if REDIS_URL is unset)
# REDIS_URL=redis://localhost:6379
```

Start the local development server (Redis must be running)

```bash
# In the root directory
pnpm dev
```

This will start:

- Frontend: http://localhost:5173
- Backend: http://127.0.0.1:3001

## Project Structure

```
smart-music-library/
├── frontend/          # React frontend application
│   ├── src/
│   │   ├── components/  # React components
│   │   ├── pages/       # Page components
│   │   ├── services/    # API client
│   │   └── utils/       # Utility functions
├── backend/           # Express backend server
│   ├── src/
│   │   ├── routes/      # API routes
│   │   ├── services/    # Business logic
│   │   ├── middleware/  # Express middleware
│   │   └── jobs/        # Background jobs
└── shared/            # Shared TypeScript types
    └── src/
        ├── types.ts     # Type definitions
        └── parser.ts    # Data transformers
```

## API Endpoints

### Authentication

- `GET /api/auth/youtube/login` - Initiate YouTube OAuth flow
- `GET /api/auth/youtube/callback` - YouTube OAuth callback
- `POST /api/auth/youtube/logout` - Logout
- `POST /api/auth/youtube/refresh` - Refresh YouTube access token
- `GET /api/auth/me` - Current user

### Data Persistence

- `POST /api/persist` - Start data sync job
- `GET /api/persist/status` - Get sync status (active job progress, or the outcome of the last sync)
- `DELETE /api/persist` - Delete cached data (including wishlist marks and playlist types)

A sync builds a complete new copy of the library and only swaps it in once it
has succeeded, so the previous library stays available while syncing and
after a failed sync. Wishlist/ownership marks and playlist types are stored
separately and survive resyncs.

### Playlists

- `GET /api/playlists` - Get all playlists
- `GET /api/playlists/:id` - Get playlist details
- `GET /api/playlists/:id/tracks` - Get playlist tracks
- `POST /api/playlists/:id/tracks` - Add a library track to a playlist (on YouTube too)
- `GET /api/playlists/:id/analyze` - Get playlist analysis
- `PATCH /api/playlists/:id/type` - Update playlist type

### Artists

- `GET /api/artists` - Get all artists
- `GET /api/artists/:id` - Get artist details
- `GET /api/artists/:id/tracks` - Get artist tracks

### Albums

- `GET /api/albums/:id` - Get album details
- `GET /api/albums/:id/tracks` - Get album tracks

### Tracks

- `GET /api/tracks` - Get all cached tracks
- `GET /api/tracks/saved` - Get liked songs
- `DELETE /api/tracks/saved/:id` - Remove a like (on YouTube too)
- `GET /api/tracks/aggregate` - Get aggregated liked-songs stats
- `PATCH /api/tracks/:id/ownership` - Update wishlist ownership state (`not-owned`, `wishlist`, `owned`)
- `POST /api/tracks/playlist-memberships` - Get playlist membership for a set of tracks

### Search

- `GET /api/search?q=` - Search across the cached library

### Statistics

- `GET /api/stats` - Library statistics
- `GET /api/playlists/:id/stats` - Statistics for one playlist

Release years come from the YouTube Music track description ("Released on" /
℗) when available. Other tracks (music videos, fan uploads) are looked up on
MusicBrainz in the background after a sync, at most one request per second,
and cached for every user. Set `MUSICBRAINZ_CONTACT` to identify your
deployment to MusicBrainz, or `MUSICBRAINZ_ENABLED=false` to turn lookups off.

### Health

- `GET /api/health` - Liveness check (pings Redis)

## Tests

```bash
pnpm test
```

Backend integration tests start a throwaway `redis-server` on a random port
and are skipped if `redis-server` isn't installed.

## License

MIT
