export interface Job {
  externalId: string;
  title: string;
  organization: string;
  location: string;
  deadline: string;
  sectors: string[];
  description: string;
  originalUrl: string;
}

export interface ScraperOutput {
  scrapedAt: string;
  totalJobs: number;
  jobs: Job[];
}
