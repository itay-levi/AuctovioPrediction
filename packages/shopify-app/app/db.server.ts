import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobal: PrismaClient;
}

// Neon serverless PostgreSQL can take a few seconds to wake from cold sleep.
// These settings prevent P2028 "Unable to start a transaction in the given time"
// errors that happen when the DB is cold and Prisma's default 5s timeout is too short.
function makePrisma() {
  return new PrismaClient({
    transactionOptions: {
      timeout: 30_000,   // 30 s — enough for a Neon cold start
      maxWait: 15_000,   // wait up to 15 s to acquire the connection
    },
  });
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = makePrisma();
  }
}

const prisma = global.prismaGlobal ?? makePrisma();

export default prisma;
