# Included in every location: nginx drops server-level add_header lines in any location
# that sets its own. Not named *.conf, so conf.d doesn't load it a second time.
#
# style-src needs 'unsafe-inline' because MUI (Emotion) injects <style> tags. Scripts stay 'self'.
# Firebase sign-in (popup): its helper script, the auth iframe on the project's authDomain, and
# the token endpoints. A different VITE_FIREBASE_AUTH_DOMAIN must replace the frame-src host.
# Media is served by the API on the same origin; blob: is for the video captions the viewer
# builds in the browser from the transcript.
add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://apis.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com; frame-src https://comp523.firebaseapp.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
# No includeSubDomains/preload: the host sits under UNC's shared apps.cloudapps.unc.edu.
add_header Strict-Transport-Security "max-age=31536000" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
# Keep the opener policy compatible with Firebase popup sign-in.
add_header Cross-Origin-Opener-Policy "same-origin-allow-popups" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
