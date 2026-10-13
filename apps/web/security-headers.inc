# Included in every location: nginx drops server-level add_header lines in any location
# that sets its own. Not named *.conf, so conf.d doesn't load it a second time.
#
# style-src needs 'unsafe-inline' because MUI (Emotion) injects <style> tags. Scripts stay 'self'.
# Firebase sign-in and the media host get added to connect-src/frame-src/media-src when they land.
add_header Content-Security-Policy "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
# No includeSubDomains/preload: the host sits under UNC's shared apps.cloudapps.unc.edu.
add_header Strict-Transport-Security "max-age=31536000" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
# Keeps other windows from scripting this page. allow-popups leaves room for Firebase's
# sign-in popup (signInWithPopup) once sign-in lands.
add_header Cross-Origin-Opener-Policy "same-origin-allow-popups" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
