import { Pool } from 'pg';
import { readFile } from 'fs/promises';
import type { ScraperOutput } from './types.js';

// Load connection string from environment variable
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is required');
  console.error('');
  console.error('Set it with:');
  console.error('  export DATABASE_URL="postgresql://user:pass@ep-xxx.neon.tech/dbname?sslmode=require"');
  console.error('');
  console.error('Get your connection string from: https://console.neon.tech');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function createTableIfNotExists(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        external_id VARCHAR(20) UNIQUE NOT NULL,
        title VARCHAR(500) NOT NULL,
        organization VARCHAR(500),
        location VARCHAR(200),
        deadline VARCHAR(50),
        sectors TEXT[],
        description TEXT,
        original_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes if they don't exist
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_external_id ON jobs(external_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_deadline ON jobs(deadline)
    `);

    console.log('Database table ready');
  } finally {
    client.release();
  }
}

async function importJobs(inputFile: string): Promise<void> {
  console.log(`Reading jobs from ${inputFile}...`);

  const content = await readFile(inputFile, 'utf-8');
  const data: ScraperOutput = JSON.parse(content);

  console.log(`Found ${data.jobs.length} jobs to import`);
  console.log(`Scraped at: ${data.scrapedAt}`);
  console.log('');

  // Ensure table exists
  await createTableIfNotExists();

  const client = await pool.connect();

  try {
    let inserted = 0;
    let updated = 0;
    let errors = 0;

    for (const job of data.jobs) {
      try {
        // Use upsert to handle duplicates
        const result = await client.query(`
          INSERT INTO jobs (external_id, title, organization, location, deadline, sectors, description, original_url)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (external_id)
          DO UPDATE SET
            title = EXCLUDED.title,
            organization = EXCLUDED.organization,
            location = EXCLUDED.location,
            deadline = EXCLUDED.deadline,
            sectors = EXCLUDED.sectors,
            description = EXCLUDED.description,
            original_url = EXCLUDED.original_url,
            updated_at = CURRENT_TIMESTAMP
          RETURNING (xmax = 0) AS inserted
        `, [
          job.externalId,
          job.title,
          job.organization,
          job.location,
          job.deadline,
          job.sectors,
          job.description,
          job.originalUrl
        ]);

        if (result.rows[0].inserted) {
          inserted++;
          console.log(`  [INSERT] ${job.externalId}: ${job.title.substring(0, 50)}...`);
        } else {
          updated++;
          console.log(`  [UPDATE] ${job.externalId}: ${job.title.substring(0, 50)}...`);
        }
      } catch (error) {
        console.error(`  [ERROR] ${job.externalId}: ${error}`);
        errors++;
      }
    }

    console.log('');
    console.log('Import complete:');
    console.log(`  Inserted: ${inserted}`);
    console.log(`  Updated:  ${updated}`);
    console.log(`  Errors:   ${errors}`);
    console.log(`  Total:    ${data.jobs.length}`);

  } finally {
    client.release();
    await pool.end();
  }
}

// Get input file from command line or use default
const inputFile = process.argv[2] || 'output/jobs.json';

importJobs(inputFile).catch((error) => {
  console.error('Import failed:', error);
  process.exit(1);
});
