import { Navigate, Route, Routes } from "react-router-dom";
import "./App.css";
import { AuthProvider } from "./contexts/AuthContext";
import { SettingsProvider } from "./contexts/SettingsContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { Artists } from "./pages/Artists";
import { ArtistView } from "./pages/ArtistView";
import { AlbumView } from "./pages/AlbumView";
import { Home } from "./pages/Home";
import { Playlists } from "./pages/Playlists";
import { PlaylistView } from "./pages/PlaylistView";
import { SavedTracks } from "./pages/SavedTracks";
import { Settings } from "./pages/Settings";
import { SyncRequired } from "./pages/SyncRequired";
import { Wishlist } from "./pages/Wishlist";
import { Layout } from "./components/Layout";

function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <SettingsProvider>
          <Routes>
            <Route path="/login" element={<Home />} />
            <Route path="/" element={<Layout />}>
              <Route index element={<Navigate to="/saved-tracks" replace />} />
              <Route path="sync" element={<SyncRequired />} />
              <Route path="playlists" element={<Playlists />} />
              <Route path="playlists/:id" element={<PlaylistView />} />
              <Route path="saved-tracks" element={<SavedTracks />} />
              <Route path="artists" element={<Artists />} />
              <Route path="artists/:id" element={<ArtistView />} />
              <Route path="albums/:id" element={<AlbumView />} />
              <Route path="wishlist" element={<Wishlist />} />
              <Route path="settings" element={<Settings />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </SettingsProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}

export default App;
