import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobal: PrismaClient;
}

// Neon serverless PostgreSQL can take a few seconds to wake from cold sleep.
// DATABASE_URL should point to the Neon connection pooler (-pooler hostname)
// which stays warm. DIRECT_DATABASE_URL is used only by prisma db push/migrate.
function makePrisma() {
  return new PrismaClient({
    transactionOptions: {
      timeout: 30_000,   // 30 s — enough for a Neon cold start
      maxWait: 15_000,   // wait up to 15 s to acquire the connection
    },
    datasourceUrl: process.env.DATABASE_URL, // explicit — ensures pooler URL is used
  });
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = makePrisma();
  }
}

const prisma = global.prismaGlobal ?? makePrisma();

export default prisma;
