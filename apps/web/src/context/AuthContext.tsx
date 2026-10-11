"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/apiClient";
import { disconnectSocket, getSocket } from "@/lib/socket";
import type { User } from "@fluxboard/shared-types";
import { getPostAuthRedirect } from "@/lib/authRedirect";

interface AuthContextValue {
  user: User | null;
  /** Session-presence sentinel; the actual JWT remains in an httpOnly cookie. */
  accessToken: string | null;
  /** True while the initial "am I already logged in?" check on page load is running. */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_FLAG = "authenticated"; // sentinel value — see the accessToken doc comment above

/**
 * Wraps the whole app (added in layout.tsx) so any component can call
 * `useAuth()` to read the current user or trigger login/signup/logout,
 * without prop-drilling auth state through every page.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // On first load, just ask the API who we are — the browser attaches the
  // httpOnly accessToken cookie automatically if one exists (see
  // apiClient's `credentials: "include"`), so there's nothing to read out
  // of localStorage first the way there used to be. A 401 here just means
  // "not logged in", not an error to report — the person lands on /login
  // the same as anyone else with no session.
  useEffect(() => {
    apiFetch<User>("/auth/me")
      .then((fetchedUser) => {
        setUser(fetchedUser);
        setAccessToken(SESSION_FLAG);
      })
      .catch(() => {
        // Not logged in (or the one-time refresh apiFetch already
        // attempted internally also failed) — nothing to clean up, since
        // there's no local token storage left to clear.
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Connects the shared socket once we know we're authenticated. The
  // connection obtains its short-lived authentication ticket through the
  // same-origin API proxy (see lib/socket.ts).
  useEffect(() => {
    if (accessToken) getSocket();
  }, [accessToken]);

  async function login(email: string, password: string) {
    // The response body only contains the user profile now — both tokens
    // are set as httpOnly cookies directly by the server's Set-Cookie
    // headers, never present in JSON the frontend could read.
    const result = await apiFetch<{ user: User }>("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    setUser(result.user);
    setAccessToken(SESSION_FLAG);
    setIsLoading(false);
    router.push(
      typeof window === "undefined"
        ? "/workspaces"
        : getPostAuthRedirect(window.location.search)
    );
  }

  async function signup(email: string, password: string, displayName: string) {
    const result = await apiFetch<{ user: User }>("/auth/signup", {
      method: "POST",
      body: { email, password, displayName },
    });
    setUser(result.user);
    setAccessToken(SESSION_FLAG);
    setIsLoading(false);
    router.push(
      typeof window === "undefined"
        ? "/workspaces"
        : getPostAuthRedirect(window.location.search)
    );
  }

  async function logout() {
    try {
      // Clears both cookies server-side — unlike localStorage, an httpOnly
      // cookie can't just be deleted client-side, so this request is what
      // actually ends the session rather than merely hiding it from this
      // one tab.
      await apiFetch("/auth/logout", { method: "POST" });
    } catch (err) {
      // Even if this call fails (e.g. the API is briefly unreachable),
      // still proceed with clearing local state below — a stuck "can't
      // log out" experience would be worse than a cookie that outlives
      // this particular attempt and simply expires on its own later.
    }
    setUser(null);
    setAccessToken(null);
    disconnectSocket();
    router.push("/login");
  }

  return (
    <AuthContext.Provider value={{ user, accessToken, isLoading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

/** Convenience hook — throws early if used outside <AuthProvider>, rather than silently returning null. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return ctx;
}
