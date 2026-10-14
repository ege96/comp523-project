import type { FirebaseWebConfig } from "../config";
import type { AuthClient } from "./authClient";

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
          user ? { uid: user.uid, email: user.email, getIdToken: () => user.getIdToken() } : null,
        );
      }),
    signInWithGoogle: async () => {
      await firebaseAuth.signInWithPopup(auth, new firebaseAuth.GoogleAuthProvider());
    },
    signOut: () => firebaseAuth.signOut(auth),
  };
}
