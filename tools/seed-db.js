import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const seedsDir = join(rootDir, "db", "seeds");
const databaseUrl = process.env.DATABASE_URL || "postgres://visionguard:visionguard_dev_password@127.0.0.1:5438/visionguard";

const pool = new Pool({ connectionString: databaseUrl });

async function main() {
  const files = (await readdir(seedsDir))
    .filter((file) => /^\d+_.+\.sql$/i.test(file))
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) {
    console.log("No seed files found.");
    return;
  }

  const client = await pool.connect();
  try {
    for (const file of files) {
      const sql = await readFile(join(seedsDir, file), "utf8");
      console.log(`SEED ${file}`);
      await client.query(sql);
    }
    console.log("Database seed complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Seed failed: ${error.message}`);
  process.exit(1);
});
