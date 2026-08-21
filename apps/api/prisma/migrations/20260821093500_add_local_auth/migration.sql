-- Issue #31: lightweight local accounts. Passwords are stored only as
-- irreversible Argon2id hashes; there is intentionally no session table.
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "username" VARCHAR(50) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "password_version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "app_user_username_key" ON "app_user"("username");
