import pg from "pg";

export type Db = pg.Pool;

export function createDb(databaseUrl = process.env.DATABASE_URL): Db {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}
