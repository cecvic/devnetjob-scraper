import { Command } from 'commander';
import { scrapeJobs } from './scraper.js';
import { importJobs } from './import-to-neon.js';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

const program = new Command();

program
  .name('devnetjobs-scraper')
  .description('CLI scraper for DevNetJobsIndia.org')
  .version('1.0.0');

program
  .command('scrape')
  .description('Scrape all jobs from DevNetJobsIndia.org')
  .option('-l, --limit <number>', 'Limit number of jobs to scrape', (val) => parseInt(val), 500)
  .option('-o, --output <path>', 'Output file path', 'output/jobs.json')
  .action(async (options) => {
    try {
      console.log('Starting DevNetJobsIndia scraper...');

      if (options.limit) {
        console.log(`Limiting to ${options.limit} jobs`);
      }

      const result = await scrapeJobs(options.limit);

      // Ensure output directory exists
      await mkdir(dirname(options.output), { recursive: true });

      // Write output to JSON file
      await writeFile(options.output, JSON.stringify(result, null, 2));

      console.log(`\nScraping complete!`);
      console.log(`Total jobs: ${result.totalJobs}`);
      console.log(`Output saved to: ${options.output}`);

      // Auto-import to database
      console.log('\nStarting database import...');
      await importJobs(options.output, false); // false = don't close pool yet, though currently importJobs closes it. 
      // Note: importJobs in its current form closes the pool at the end. 
      // We might need to adjust import-to-neon.ts if we want to be cleaner, 
      // but calling it as is should work if it's the last thing we do.
    } catch (error) {
      console.error('Scraping failed:', error);
      process.exit(1);
    }
  });

program.parse();
