export type AuthUser = {
  uid: string;
  email: string | null;
  /** A fresh Firebase ID token for `Authorization: Bearer`; Firebase refreshes it as needed. */
  getIdToken: () => Promise<string>;
};

/** The slice of Firebase Auth the app uses, so tests (and another provider) can swap it. */
export interface AuthClient {
  /** Called with the current user now and whenever they sign in or out. Returns unsubscribe. */
  onUserChanged(callback: (user: AuthUser | null) => void): () => void;
  signInWithGoogle(): Promise<void>;
  signOut(): Promise<void>;
}
