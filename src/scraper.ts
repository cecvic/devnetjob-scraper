import { chromium, Page } from 'playwright';
import type { Job, ScraperOutput } from './types.js';

const BASE_URL = 'https://devnetjobsindia.org';
const SEARCH_PAGE_URL = `${BASE_URL}/search_jobs.aspx`;

export async function scrapeJobs(limit?: number): Promise<ScraperOutput> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Get the most recent job ID from the search page
    console.log('Finding most recent job ID...');
    const startId = await findMostRecentJobId(page);
    console.log(`Most recent job ID: ${startId}`);

    // Scan backwards from the most recent ID to find all valid jobs
    const jobIds = await scanJobIds(page, startId, limit);
    console.log(`Found ${jobIds.length} valid job IDs`);

    // Scrape details for each job
    const jobs: Job[] = [];
    for (let i = 0; i < jobIds.length; i++) {
      const jobId = jobIds[i];
      console.log(`Scraping job ${i + 1}/${jobIds.length}: ${jobId}`);

      try {
        const job = await scrapeJobDetails(page, jobId);
        jobs.push(job);
      } catch (error) {
        console.error(`Failed to scrape job ${jobId}:`, error);
      }

      // Small delay
      if (i < jobIds.length - 1) {
        await page.waitForTimeout(300);
      }
    }

    return {
      scrapedAt: new Date().toISOString(),
      totalJobs: jobs.length,
      jobs,
    };
  } finally {
    await browser.close();
  }
}

async function findMostRecentJobId(page: Page): Promise<number> {
  // Navigate to search and click first job to get its ID
  console.log('  Opening search page...');
  await page.goto(SEARCH_PAGE_URL, { waitUntil: 'networkidle' });

  console.log('  Clicking search button...');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Try to click a job link multiple times
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      console.log(`  Clicking first job link (attempt ${attempt + 1})...`);
      const firstJobLink = page.locator('a[href*="lnkJobTitle"]').first();

      if (await firstJobLink.count() === 0) {
        console.log('  No job links found, waiting...');
        await page.waitForTimeout(2000);
        continue;
      }

      await firstJobLink.click({ timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 });

      // Extract job ID from URL
      const url = page.url();
      console.log(`  Current URL: ${url}`);
      const match = url.match(/Job_Id=(\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }

      // If we didn't get a job page, try going back and trying again
      await page.goBack();
      await page.waitForLoadState('networkidle');
    } catch (error) {
      console.log(`  Attempt ${attempt + 1} failed: ${error}`);
    }
  }

  // Fallback: use a known recent job ID
  console.log('  Using fallback job ID...');
  return 285453; // Known recent job ID from earlier testing
}

async function isValidJobId(page: Page, jobId: number): Promise<boolean> {
  try {
    const url = `${BASE_URL}/JobDescription.aspx?Job_Id=${jobId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });

    // Check if page has a valid job title (h1 element with content)
    const title = await page.locator('h1').first().innerText({ timeout: 3000 }).catch(() => '');
    return title.length > 0 && !title.includes('Error') && !title.includes('Untitled');
  } catch {
    return false;
  }
}

async function scanJobIds(page: Page, startId: number, limit?: number): Promise<string[]> {
  const jobIds: string[] = [];
  let consecutiveInvalid = 0;
  const maxConsecutiveInvalid = 100; // Stop after 100 consecutive invalid IDs

  console.log(`Scanning job IDs starting from ${startId}...`);

  // Scan downward from the most recent job
  for (let id = startId; consecutiveInvalid < maxConsecutiveInvalid; id--) {
    if (limit && jobIds.length >= limit) {
      console.log(`Reached limit of ${limit} jobs`);
      break;
    }

    const isValid = await isValidJobId(page, id);
    if (isValid) {
      jobIds.push(id.toString());
      consecutiveInvalid = 0;

      if (jobIds.length % 10 === 0) {
        console.log(`  Found ${jobIds.length} jobs so far (current ID: ${id})`);
      }
    } else {
      consecutiveInvalid++;
    }
  }

  return jobIds;
}

async function scrapeJobDetails(page: Page, jobId: string): Promise<Job> {
  const url = `${BASE_URL}/JobDescription.aspx?Job_Id=${jobId}`;
  await page.goto(url, { waitUntil: 'networkidle' });

  // Extract job title from h1
  const title = await page.locator('h1').first().innerText().catch(() => 'Unknown Title');

  // Extract organization from h5
  const organization = await page.locator('h5').first().innerText().catch(() => 'Unknown Organization');

  // Extract location
  const locationText = await page.locator('p:has-text("Location:")').first().innerText().catch(() => 'Location: India');
  const location = locationText.replace('Location:', '').trim() || 'India';

  // Extract deadline
  const deadlineText = await page.locator('p:has-text("Apply by:")').first().innerText().catch(() => 'Apply by: Unknown');
  const deadline = deadlineText.replace('Apply by:', '').trim() || 'Unknown';

  // Extract sectors
  const sectors: string[] = [];
  try {
    const pageContent = await page.content();
    const sectorMatch = pageContent.match(/Relevant Sectors<\/p>\s*<p[^>]*>([^<]+)<\/p>(?:\s*<p[^>]*>([^<]+)<\/p>)?/);
    if (sectorMatch) {
      if (sectorMatch[1] && !sectorMatch[1].includes('<')) {
        sectors.push(sectorMatch[1].trim());
      }
      if (sectorMatch[2] && !sectorMatch[2].includes('<')) {
        sectors.push(sectorMatch[2].trim());
      }
    }
  } catch {
    // Ignore sector extraction errors
  }

  // Extract full description
  let description = '';
  try {
    const mainContent = page.locator('body');
    const fullText = await mainContent.innerText();

    const lines = fullText.split('\n');
    const descLines: string[] = [];
    let inDescription = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === title.trim()) {
        inDescription = true;
        continue;
      }
      if (trimmed.includes('View Similar Jobs:') || trimmed.includes('Subscribe to Value Membership')) {
        break;
      }
      if (inDescription && trimmed) {
        descLines.push(trimmed);
      }
    }

    description = descLines.join('\n').trim();
  } catch {
    description = '';
  }

  return {
    externalId: jobId,
    title: title.trim(),
    organization: organization.trim(),
    location: location.trim(),
    deadline: deadline.trim(),
    sectors: sectors.length > 0 ? sectors : ['General'],
    description: description.trim(),
    originalUrl: url,
  };
}
