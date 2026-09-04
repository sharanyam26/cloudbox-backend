-- CreateTable
CREATE TABLE "LinkShare" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "password" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkShare_token_key" ON "LinkShare"("token");
