import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { checkAdmin } from "../api/client";
import { FIREBASE_CONFIG } from "../config";
import type { AuthClient, AuthUser } from "./authClient";
import { AuthContext, type AuthContextValue, type AuthState } from "./useAuth";

// Set while someone is signed in, so a later visit knows to load Firebase straight away.
// Visitors who never signed in on this browser never download Firebase.
const HINT_KEY = "swayambhu.auth.v1";

function readHint(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHint(signedIn: boolean) {
  try {
    if (signedIn) localStorage.setItem(HINT_KEY, "1");
    else localStorage.removeItem(HINT_KEY);
  } catch {
    // Storage blocked: the only cost is loading Firebase later.
  }
}

async function loadFirebaseClient(): Promise<AuthClient | null> {
  if (!FIREBASE_CONFIG) return null;
  const { createFirebaseAuthClient } = await import("./firebaseClient");
  return createFirebaseAuthClient(FIREBASE_CONFIG);
}

type Session =
  { status: "unavailable" | "loading" | "signedOut" } | { status: "signedIn"; user: AuthUser };

const anonymousToken = () => Promise.resolve(null);

export function AuthProvider({
  children,
  loadClient = loadFirebaseClient,
}: {
  children: ReactNode;
  loadClient?: () => Promise<AuthClient | null>;
}) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session>(() =>
    readHint() ? { status: "loading" } : { status: "signedOut" },
  );
  const [client, setClient] = useState<AuthClient | null>(null);
  const loading = useRef(false);
  const lastUid = useRef<string | null>(null);

  const connect = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    loadClient()
      .then((loaded) => {
        if (loaded) setClient(loaded);
        else setSession({ status: "unavailable" });
      })
      .catch(() => {
        setSession({ status: "unavailable" });
      });
  }, [loadClient]);

  useEffect(() => {
    if (readHint()) connect();
  }, [connect]);

  useEffect(() => {
    if (!client) return;
    return client.onUserChanged((user) => {
      // Someone else's (or no one's) session now: drop everything cached for the last one.
      if (lastUid.current !== null && lastUid.current !== user?.uid) queryClient.clear();
      lastUid.current = user?.uid ?? null;
      writeHint(user !== null);
      setSession(user ? { status: "signedIn", user } : { status: "signedOut" });
    });
  }, [client, queryClient]);

  const user = session.status === "signedIn" ? session.user : null;
  const roleQuery = useQuery({
    queryKey: ["auth", "me", user?.uid],
    queryFn: () =>
      user ? user.getIdToken().then(checkAdmin) : Promise.reject(new Error("Not signed in")),
    enabled: user !== null,
    staleTime: 5 * 60_000,
  });

  const state: AuthState =
    session.status === "signedIn"
      ? {
          status: "signedIn",
          email: session.user.email,
          emailVerified: session.user.emailVerified,
          role: roleQuery.isError ? "error" : (roleQuery.data ?? "checking"),
        }
      : session;

  const viewer = useMemo(
    () => ({
      key: user?.uid ?? "anon",
      getToken: user ? () => user.getIdToken() : anonymousToken,
      ready: session.status !== "loading",
    }),
    [user, session.status],
  );

  const withClient = (action: (c: AuthClient) => Promise<void>) =>
    client ? action(client) : Promise.reject(new Error("Sign-in isn't ready"));

  const value: AuthContextValue = {
    state,
    viewer,
    connect,
    canSignIn: client !== null,
    signInWithGoogle: () => withClient((c) => c.signInWithGoogle()),
    signInWithPassword: (email, password) =>
      withClient((c) => c.signInWithPassword(email, password)),
    sendPasswordReset: (email) => withClient((c) => c.sendPasswordReset(email)),
    sendEmailVerification: () => withClient((c) => c.sendEmailVerification()),
    signOut: () => (client ? client.signOut() : Promise.resolve()),
  };

  return <AuthContext value={value}>{children}</AuthContext>;
}
