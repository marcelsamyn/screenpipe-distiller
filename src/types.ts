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

export interface ConversationMessage {
  sender: string;
  fromMe: boolean;
  text: string;
  timestamp: string; // ISO
}

export interface Conversation {
  channel: string; // e.g. "WhatsApp"
  chatName: string;
  isGroup: boolean;
  messages: ConversationMessage[];
}

export interface DayDigest {
  dayKey: string;
  apps: AppActivity[];
  audio: AudioSnippet[];
  conversations: Conversation[];
  totalFrames: number;
  isEmpty: boolean;
}

export interface CuratedDoc {
  markdown: string;
  isEmptyDay: boolean;
}
