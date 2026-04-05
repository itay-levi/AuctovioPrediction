import { PrismaClient, Prisma } from "@prisma/client";

declare global {
  var prismaGlobal: ReturnType<typeof makePrisma>;
}

function isNeonColdStart(e: unknown): boolean {
  // P1001 = "Can't reach database server" (Neon suspended)
  // PrismaClientInitializationError = connection failed before any query
  return (
    (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P1001") ||
    e instanceof Prisma.PrismaClientInitializationError
  );
}

function makePrisma() {
  const base = new PrismaClient({
    transactionOptions: { timeout: 30_000, maxWait: 15_000 },
    datasourceUrl: process.env.DATABASE_URL,
  });

  // Use Prisma's official query extension to retry on Neon cold start.
  // Neon free tier suspends after ~5 min of inactivity; the first query after
  // suspension fails with P1001. We retry up to 3 times (1s → 2s → 3s).
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const MAX = 3;
          for (let attempt = 1; attempt <= MAX; attempt++) {
            try {
              return await query(args);
            } catch (e) {
              if (isNeonColdStart(e) && attempt < MAX) {
                const wait = attempt * 1000;
                console.warn(
                  `[db] Neon cold start — retrying in ${wait}ms (attempt ${attempt}/${MAX})`
                );
                await new Promise((r) => setTimeout(r, wait));
                continue;
              }
              throw e;
            }
          }
          throw new Error("unreachable");
        },
      },
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
