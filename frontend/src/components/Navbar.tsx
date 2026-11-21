import {
  BarChart3,
  Gift,
  Heart,
  LogOut,
  Music,
  Settings,
  Users,
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { getAppName } from "../utils";
import { SearchDialog } from "./SearchDialog";
import { AppLogo } from "./AppLogo";
import { SyncModal } from "./SyncModal";

export function Navbar() {
  const { logout } = useAuth();
  const location = useLocation();
  const appName = getAppName();

  const handleLogout = () => {
    logout();
  };

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  const navLinks = [
    { path: "/saved-tracks", label: "Liked Songs", icon: Heart },
    { path: "/playlists", label: "Playlists", icon: Music },
    { path: "/artists", label: "Artists", icon: Users },
    { path: "/wishlist", label: "Wishlist", icon: Gift },
    { path: "/statistics", label: "Statistics", icon: BarChart3 },
    { path: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <nav className="bg-base-300 border-b border-base-200 sticky top-0 z-50">
      <div className="px-4 sm:px-6 py-3">
        <div className="flex items-center justify-between gap-3">
          <Link
            to="/"
            className="flex font-bold text-lg gap-2 items-center text-base-content hover:text-primary transition-colors group"
          >
            <AppLogo className="size-7 group-hover:scale-110 transition-transform text-primary" />
            <span className="hidden md:inline">{appName}</span>
          </Link>

          <div className="flex items-center gap-2 sm:gap-6 min-w-0">
            {/* Icon-only below xl so the bar fits narrow screens; scrolls as
                a last resort instead of overflowing the page. */}
            <ul className="flex items-center gap-1 min-w-0 overflow-x-auto">
              <li>
                <SearchDialog />
              </li>
              {navLinks.map(({ path, label, icon: Icon }) => (
                <li key={path}>
                  <Link
                    to={path}
                    title={label}
                    aria-label={label}
                    className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-all duration-150 ${
                      isActive(path)
                        ? "bg-primary/10 text-primary"
                        : "text-base-content/70 hover:text-base-content hover:bg-base-300/50"
                    }`}
                  >
                    <Icon size={16} className="shrink-0" />
                    <span className="hidden xl:inline">{label}</span>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="flex items-center gap-1 sm:gap-2 pl-2 sm:pl-4 border-l border-base-200 shrink-0">
              <SyncModal />
              <button
                onClick={handleLogout}
                className="btn btn-ghost btn-sm gap-2"
                title="Logout"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden xl:inline">Logout</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
