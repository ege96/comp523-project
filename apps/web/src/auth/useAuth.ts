import { createContext, use } from "react";

import type { Viewer } from "../api/client";

export type AuthState =
  | { status: "unavailable" } // sign-in isn't configured, or Firebase couldn't load
  | { status: "loading" }
  | { status: "signedOut" }
  | {
      status: "signedIn";
      email: string | null;
      emailVerified: boolean;
      /** From the API, not Firebase. "error" means the check itself failed. */
      role: "checking" | "admin" | "notAdmin" | "error";
    };

export type AuthContextValue = {
  state: AuthState;
  /** Pass to every API query; `ready` is false until we know whether someone is signed in. */
  viewer: Viewer & { ready: boolean };
  /** Loads Firebase. Call before offering sign-in, so the popup opens inside the click. */
  connect: () => void;
  canSignIn: boolean;
  signInWithGoogle: () => Promise<void>;
  /** Rejects with SignInError. */
  signInWithPassword: (email: string, password: string) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  sendEmailVerification: () => Promise<void>;
  signOut: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
