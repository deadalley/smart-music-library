import { AppUser } from "@smart-music-library/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, ReactNode, useContext, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { authAPI } from "../services/api";

// Left over from when the app supported more than one music source.
const LEGACY_AUTH_SOURCE_STORAGE_KEY = "smart_spotify_auth_source";

interface AuthContextType {
  user: AppUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const { data: user, isLoading } = useQuery({
    queryKey: ["user"],
    queryFn: async () => (await authAPI.getUser()).data,
    retry: false,
    staleTime: Infinity,
  });

  const logoutMutation = useMutation({
    mutationFn: () => authAPI.logout(),
    // Always drop the local session, even if the network call fails (e.g.
    // offline) — the user's intent to log out shouldn't get stuck waiting
    // on the server.
    onSettled: () => {
      queryClient.clear();
      navigate("/login");
    },
  });

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_AUTH_SOURCE_STORAGE_KEY);
    } catch {
      // storage unavailable (private mode etc.) — nothing to clean up
    }
  }, []);

  useEffect(() => {
    if (user && location.pathname.startsWith("/login")) {
      navigate("/", { replace: true });
    }
  }, [user, location.pathname, navigate]);

  const value: AuthContextType = {
    user: user ?? null,
    isLoading,
    isAuthenticated: !!user,
    login: () => authAPI.login(),
    logout: () => logoutMutation.mutate(),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
