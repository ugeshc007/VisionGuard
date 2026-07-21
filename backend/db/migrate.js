import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const databaseUrl = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: databaseUrl });

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function checksum(text) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

async function main() {
  const client = await pool.connect();
  try {
    await ensureMigrationTable(client);
    const appliedRows = await client.query("SELECT version FROM schema_migrations");
    const applied = new Set(appliedRows.rows.map((row) => row.version));
    const files = (await readdir(migrationsDir))
      .filter((file) => /^\d+_.+\.sql$/i.test(file))
      .sort((a, b) => a.localeCompare(b));

    if (!files.length) {
      console.log("No migration files found.");
      return;
    }

    for (const file of files) {
      const version = file.split("_")[0];
      if (applied.has(version)) {
        console.log(`SKIP ${file}`);
        continue;
      }
      const sql = await readFile(join(migrationsDir, file), "utf8");
      console.log(`APPLY ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [version, file, await checksum(sql)]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.log("Database migrations complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exit(1);
});
