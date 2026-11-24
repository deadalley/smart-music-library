import { useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { YouTubeLogo } from "../components/YouTubeLogo";
import { AppLogo } from "../components/AppLogo";

const YOUTUBE_LOGIN_ERROR_MESSAGES: Record<string, string> = {
  youtube_not_configured: "YouTube login isn't configured on the server.",
  youtube_missing_code: "YouTube didn't return an authorization code.",
  youtube_state_mismatch: "Login session expired, please try again.",
  youtube_invalid_token: "Failed to complete YouTube login, please try again.",
  youtube_exchange_failed:
    "Google didn't accept the login. Please try again; if it keeps failing, the server's Google OAuth settings may be wrong.",
  youtube_quota_exceeded:
    "YouTube's daily API quota for this app has been used up. Try again after midnight Pacific time.",
  youtube_channel_failed:
    "Signed in with Google, but couldn't load your YouTube channel. Please try again.",
  storage_unavailable:
    "Signed in, but the server couldn't save your session (database unavailable). Please try again later.",
  youtube_missing_scopes:
    "Please grant access to your YouTube data to continue.",
};

export function Home() {
  const { login } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const error = searchParams.get("error");
  // Short, non-secret code from Google/the server (e.g. "invalid_grant"),
  // shown so a failure can be diagnosed without server logs.
  const reason = searchParams.get("reason");

  return (
    <div className="w-screen h-screen flex flex-col justify-center items-center">
      <div className="flex flex-col gap-5 items-center max-w-lg w-full px-6">
        <AppLogo className="size-20 text-primary" title="Smart Music" />
        <h1 className="text-4xl font-bold text-center">Smart Music</h1>

        {error && (
          <div className="alert alert-error max-w-md text-sm">
            <div className="flex flex-col gap-1">
              <span>
                {YOUTUBE_LOGIN_ERROR_MESSAGES[error] ??
                  "Something went wrong signing in, please try again."}
              </span>
              <span className="text-xs opacity-70 font-mono">
                {error}
                {reason ? ` · ${reason}` : ""}
              </span>
            </div>
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => setSearchParams({}, { replace: true })}
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="flex flex-col gap-3 mt-3">
          <div className="flex gap-3">

            <div
              className="card size-64 bg-base-100 shadow-sm hover:translate-y-[-2px] transition-transform duration-200 cursor-pointer hover:shadow-lg hover:shadow-[color:var(--color-primary-youtube)]/30"
              onClick={login}
            >
              <div className="card-body justify-center items-center gap-4 hover:text-[color:var(--color-primary-youtube)]">
                <YouTubeLogo className="size-18 text-[color:var(--color-primary-youtube)] mt-6" />
                <span className="text-lg font-medium text-center">
                  Login with YouTube Music
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
