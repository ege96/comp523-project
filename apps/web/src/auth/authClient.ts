export type AuthUser = {
  uid: string;
  email: string | null;
  /** The API links an admin invite to an account only once its email is verified. */
  emailVerified: boolean;
  /** A fresh Firebase ID token for `Authorization: Bearer`; Firebase refreshes it as needed. */
  getIdToken: () => Promise<string>;
};

/** Why a sign-in failed, as far as the page needs to know. */
export class SignInError extends Error {
  constructor(readonly reason: "badCredentials" | "tooManyAttempts" | "other") {
    super(`Sign-in failed: ${reason}`);
    this.name = "SignInError";
  }
}

/** The slice of Firebase Auth the app uses, so tests (and another provider) can swap it. */
export interface AuthClient {
  /** Called with the current user now and whenever they sign in or out. Returns unsubscribe. */
  onUserChanged(callback: (user: AuthUser | null) => void): () => void;
  signInWithGoogle(): Promise<void>;
  /** Rejects with SignInError. There is no sign-up: admins' accounts are made for them. */
  signInWithPassword(email: string, password: string): Promise<void>;
  /** Resolves whether or not the account exists, so the page can't be used to probe emails. */
  sendPasswordReset(email: string): Promise<void>;
  /** Sends the signed-in user a link that verifies their email. */
  sendEmailVerification(): Promise<void>;
  signOut(): Promise<void>;
}
