// Build-time settings, read once. Vite inlines VITE_* variables, so only public values go here.

// Same-origin by default. Set VITE_API_BASE_URL only if the API is served from another host.
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";

export type FirebaseWebConfig = { apiKey: string; authDomain: string; projectId: string };

// Proposal: the Firebase *web* config comes from VITE_FIREBASE_API_KEY and
// VITE_FIREBASE_PROJECT_ID (VITE_FIREBASE_AUTH_DOMAIN optional) at build time. These are public
// by design (they name the project; they are not secrets). Unset means sign-in is unavailable.
function readFirebaseConfig(): FirebaseWebConfig | null {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  return {
    apiKey,
    projectId,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
  };
}

export const FIREBASE_CONFIG = readFirebaseConfig();
