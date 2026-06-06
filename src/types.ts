export type ScrapedComment = {
  username: string;
  text: string;
  time?: string;
  likes?: number;
};

export type ScrapedVideo = {
  videoId: string | null;
  url: string;
  title: string | null;
  caption: string | null;
  description: string | null;
  username: string | null;
  authorUrl: string | null;
  videoSrc: string | null;
  videoDownloadUrl: string | null;
  videoFile: string | null;
  downloadError?: string;
  stats: VideoStats;
  keywordMentioned: boolean;
  comments: ScrapedComment[];
};

export type VideoStats = {
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  raw: {
    likes: string | null;
    comments: string | null;
    saved: string | null;
    shares: string | null;
  };
};

export type ScrapeSettings = {
  maxVideos: number;
  commentsPerVideo: number;
  headless: boolean;
  downloadVideo: boolean;
  skipExisting: boolean;
  registryPath: string;
};

export type ScrapeMetrics = {
  videosTargeted: number;
  videosScraped: number;
  videosSkippedExisting: number;
  totalComments: number;
  navFailures: number;
  captchasDetected: number;
};

export type ScrapeResult = {
  query: string;
  keyword: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  settings: ScrapeSettings;
  metrics: ScrapeMetrics;
  items: ScrapedVideo[];
};

export type ScrapeOptions = {
  search: string;
  keyword: string | null;
  maxVideos: number;
  commentsPerVideo: number;
  headless: boolean;
  keepBrowserOpen: boolean;
  downloadVideo: boolean;
  skipExisting: boolean;
  registryPath: string;
};

export type CliOptions = ScrapeOptions & {
  output: string | null;
};
