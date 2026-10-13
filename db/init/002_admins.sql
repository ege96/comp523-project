-- Admins (D-005: the only signed-in role). Anonymous visitors have no row.
-- An admin is invited by email; auth_provider/auth_subject are filled in on their first
-- verified sign-in and are what identify them afterwards (Firebase uid today).
CREATE TABLE IF NOT EXISTS admins (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL,
    auth_provider text,
    auth_subject text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT admins_identity_complete CHECK ((auth_provider IS NULL) = (auth_subject IS NULL)),
    CONSTRAINT admins_identity_unique UNIQUE (auth_provider, auth_subject)
);

CREATE UNIQUE INDEX IF NOT EXISTS admins_email_unique ON admins (lower(email));
