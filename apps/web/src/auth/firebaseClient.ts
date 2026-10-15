import type { FirebaseWebConfig } from "../config";
import { SignInError, type AuthClient } from "./authClient";

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : null;

/**
 * Firebase is imported on demand, so public visitors who never sign in don't download it.
 * Not unit tested: it only adapts the Firebase SDK to `AuthClient`.
 */
export async function createFirebaseAuthClient(config: FirebaseWebConfig): Promise<AuthClient> {
  const [{ initializeApp }, firebaseAuth] = await Promise.all([
    import("@firebase/app"),
    import("@firebase/auth"),
  ]);
  const auth = firebaseAuth.getAuth(initializeApp(config));
  return {
    onUserChanged: (callback) =>
      firebaseAuth.onAuthStateChanged(auth, (user) => {
        callback(
          user
            ? {
                uid: user.uid,
                email: user.email,
                emailVerified: user.emailVerified,
                getIdToken: () => user.getIdToken(),
              }
            : null,
        );
      }),
    signInWithGoogle: async () => {
      await firebaseAuth.signInWithPopup(auth, new firebaseAuth.GoogleAuthProvider());
    },
    signInWithPassword: async (email, password) => {
      try {
        await firebaseAuth.signInWithEmailAndPassword(auth, email, password);
      } catch (error) {
        // With email enumeration protection on, a wrong email and a wrong password look alike.
        const code = errorCode(error);
        throw new SignInError(
          code === "auth/invalid-credential" ||
            code === "auth/wrong-password" ||
            code === "auth/user-not-found" ||
            code === "auth/invalid-email"
            ? "badCredentials"
            : code === "auth/too-many-requests"
              ? "tooManyAttempts"
              : "other",
        );
      }
    },
    sendPasswordReset: async (email) => {
      try {
        await firebaseAuth.sendPasswordResetEmail(auth, email);
      } catch (error) {
        if (errorCode(error) !== "auth/user-not-found") throw error;
      }
    },
    sendEmailVerification: async () => {
      if (!auth.currentUser) throw new Error("Not signed in");
      await firebaseAuth.sendEmailVerification(auth.currentUser);
    },
    signOut: () => firebaseAuth.signOut(auth),
  };
}
