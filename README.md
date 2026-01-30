# DevNetJobsIndia Scraper

A CLI tool to scrape job listings from [devnetjobsindia.org](https://devnetjobsindia.org) and save them to JSON format.

## Prerequisites

- Node.js 18+
- npm or yarn

## Installation

```bash
# Install dependencies
npm install

# Install Playwright browser
npx playwright install chromium
```

## Usage

### Basic Commands

```bash
# Scrape all jobs (may take a while for ~645 jobs)
npx tsx src/index.ts scrape

# Scrape with a limit (recommended for testing)
npx tsx src/index.ts scrape --limit 50

# Specify custom output file
npx tsx src/index.ts scrape --limit 100 --output ./data/jobs.json
```

### Using npm scripts

```bash
# Quick test with 5 jobs
npm run scrape:test

# Full scrape
npm run scrape
```

### Output Format

The scraper outputs JSON in the following format:

```json
{
  "scrapedAt": "2026-01-30T02:22:24.379Z",
  "totalJobs": 20,
  "jobs": [
    {
      "externalId": "285451",
      "title": "Project Procurement Expert",
      "organization": "Strategic Alliance Management Services P Ltd.",
      "location": "Lucknow, Uttar Pradesh",
      "deadline": "08 Feb 2026",
      "sectors": ["Administration, HR, Management, Accounting/Finance"],
      "description": "Full job description text...",
      "originalUrl": "https://devnetjobsindia.org/JobDescription.aspx?Job_Id=285451"
    }
  ]
}
```

---

## Inserting Data into NeonDB

[NeonDB](https://neon.tech) is a serverless PostgreSQL database. Here's how to store your scraped jobs.

### Step 1: Create a NeonDB Account and Database

1. Sign up at [neon.tech](https://neon.tech)
2. Create a new project
3. Copy your connection string (looks like `postgresql://user:pass@host/dbname`)

### Step 2: Install PostgreSQL Client

```bash
npm install pg
npm install -D @types/pg
```

### Step 3: Create the Database Schema

Connect to your NeonDB and run this SQL:

```sql
-- Create jobs table
CREATE TABLE jobs (
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
);

-- Create index for faster lookups
CREATE INDEX idx_jobs_external_id ON jobs(external_id);
CREATE INDEX idx_jobs_deadline ON jobs(deadline);

-- Optional: Create a function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

### Step 4: Create the Import Script

Create a new file `src/import-to-neon.ts`:

```typescript
import { Pool } from 'pg';
import { readFile } from 'fs/promises';
import type { ScraperOutput, Job } from './types.js';

// Load connection string from environment variable
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is required');
  console.error('Set it with: export DATABASE_URL="postgresql://..."');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function importJobs(inputFile: string): Promise<void> {
  console.log(`Reading jobs from ${inputFile}...`);

  const content = await readFile(inputFile, 'utf-8');
  const data: ScraperOutput = JSON.parse(content);

  console.log(`Found ${data.jobs.length} jobs to import`);

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
        } else {
          updated++;
        }
      } catch (error) {
        console.error(`Error importing job ${job.externalId}:`, error);
        errors++;
      }
    }

    console.log(`\nImport complete:`);
    console.log(`  Inserted: ${inserted}`);
    console.log(`  Updated: ${updated}`);
    console.log(`  Errors: ${errors}`);

  } finally {
    client.release();
    await pool.end();
  }
}

// Get input file from command line or use default
const inputFile = process.argv[2] || 'output/jobs.json';
importJobs(inputFile).catch(console.error);
```

### Step 5: Run the Import

```bash
# Set your NeonDB connection string
export DATABASE_URL="postgresql://username:password@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require"

# Run the import script
npx tsx src/import-to-neon.ts

# Or specify a different input file
npx tsx src/import-to-neon.ts ./data/my-jobs.json
```

### Step 6: Query Your Data

Once imported, you can query your jobs:

```sql
-- Get all active jobs (deadline in future)
SELECT title, organization, location, deadline
FROM jobs
WHERE deadline > CURRENT_DATE
ORDER BY deadline;

-- Search jobs by keyword
SELECT title, organization, original_url
FROM jobs
WHERE title ILIKE '%manager%' OR description ILIKE '%manager%';

-- Get jobs by location
SELECT title, organization, deadline
FROM jobs
WHERE location ILIKE '%delhi%';

-- Count jobs by organization
SELECT organization, COUNT(*) as job_count
FROM jobs
GROUP BY organization
ORDER BY job_count DESC
LIMIT 10;
```

---

## Complete Workflow Example

```bash
# 1. Scrape jobs
npx tsx src/index.ts scrape --limit 100 --output ./output/jobs.json

# 2. Set database connection
export DATABASE_URL="postgresql://user:pass@ep-xxx.neon.tech/dbname?sslmode=require"

# 3. Import to NeonDB
npx tsx src/import-to-neon.ts ./output/jobs.json
```

---

## Scheduling Regular Scrapes

You can set up a cron job to scrape and import regularly:

```bash
# Create a shell script: scrape-and-import.sh
#!/bin/bash
cd /path/to/devnetjobs-scraper
export DATABASE_URL="your-connection-string"

# Scrape latest jobs
npx tsx src/index.ts scrape --output ./output/jobs-$(date +%Y%m%d).json

# Import to database
npx tsx src/import-to-neon.ts ./output/jobs-$(date +%Y%m%d).json
```

Add to crontab to run daily:
```bash
# Run daily at 6 AM
0 6 * * * /path/to/scrape-and-import.sh >> /var/log/scraper.log 2>&1
```

---

## Troubleshooting

### Scraper Issues

- **Timeout errors**: The website may be slow. Try running with `--limit` first.
- **No jobs found**: The website structure may have changed. Check if the site is accessible.
- **Browser not found**: Run `npx playwright install chromium` again.

### Database Issues

- **Connection refused**: Check your DATABASE_URL and ensure SSL is enabled (`?sslmode=require`).
- **Permission denied**: Verify your NeonDB credentials.
- **Duplicate key errors**: The import script uses upsert, so duplicates are updated automatically.

---

## Project Structure

```
muscat/
├── src/
│   ├── index.ts           # CLI entry point
│   ├── scraper.ts         # Playwright scraper logic
│   ├── types.ts           # TypeScript interfaces
│   └── import-to-neon.ts  # NeonDB import script (create this)
├── output/                # JSON output files (gitignored)
├── package.json
├── tsconfig.json
└── README.md
```
