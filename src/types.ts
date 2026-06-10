/** The condensed, LLM-ready summary of one day of activity. */
export interface AppActivity {
  app: string;
  windows: string[];
  urls: string[];
  sampleText: string[];
  firstSeen: string;
  lastSeen: string;
  frames: number;
}

export interface AudioSnippet {
  speaker: string | null;
  text: string;
  timestamp: string;
}

export interface DayDigest {
  dayKey: string;
  apps: AppActivity[];
  audio: AudioSnippet[];
  totalFrames: number;
  isEmpty: boolean;
}

export interface CuratedDoc {
  markdown: string;
  isEmptyDay: boolean;
}
