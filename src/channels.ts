/**
 * Conversation-channel classification for captured frames.
 * Aliases: channel detection, comms bucketing, browser conversation routing.
 *
 * Given a frame's identifying fields, decide which bucket it belongs to and
 * whether that bucket gets conversation treatment (recency sort, larger text
 * budget, rank protection). Native comms apps keep their own name; browser-based
 * conversations (WhatsApp Web, Gmail, …) are re-bucketed under a synthetic label
 * so they no longer drown in a single generic "Google Chrome" bucket.
 */

/** Minimal frame fields needed to classify a frame's conversation channel. */
export interface FrameContent {
  app_name?: string | null;
  window_name?: string | null;
  window_title?: string | null;
  browser_url?: string | null;
}

export interface ChannelClassification {
  /** The label this frame is bucketed under in the digest (the "app"). */
  bucketKey: string;
  /** Whether this bucket gets conversation treatment (recency sort, larger budget, rank protection). */
  isComms: boolean;
}

interface BrowserChannel {
  /** bucketKey when matched, e.g. "WhatsApp (web)". */
  display: string;
  /** Matched as substrings of browser_url (lowercased). */
  urlPatterns: string[];
  /** Matched as substrings of the window title (lowercased); only when the app is a browser. */
  titlePatterns: string[];
}

const BROWSER_CHANNELS: BrowserChannel[] = [
  { display: "WhatsApp (web)", urlPatterns: ["web.whatsapp.com"], titlePatterns: ["whatsapp"] },
  { display: "Slack (web)", urlPatterns: ["app.slack.com"], titlePatterns: ["slack"] },
  { display: "Gmail", urlPatterns: ["mail.google.com"], titlePatterns: ["gmail"] },
  { display: "Messenger (web)", urlPatterns: ["messenger.com"], titlePatterns: ["messenger"] },
  { display: "Discord (web)", urlPatterns: ["discord.com/channels", "discord.com/app"], titlePatterns: ["discord"] },
  { display: "Telegram (web)", urlPatterns: ["web.telegram.org"], titlePatterns: ["telegram"] },
  { display: "Teams (web)", urlPatterns: ["teams.microsoft.com", "teams.live.com"], titlePatterns: ["microsoft teams"] },
];

// Native communication apps whose on-screen text is conversation, not UI chrome.
// Lowercased substring match against app_name.
const COMMUNICATION_APPS = [
  "slack",
  "messages",
  "mail",
  "whatsapp",
  "discord",
  "telegram",
  "signal",
  "zoom",
  "microsoft teams",
  "teams",
  "messenger",
  "superhuman",
  "outlook",
];

const BROWSERS = ["chrome", "safari", "arc", "firefox", "edge", "brave", "vivaldi", "opera"];

export function isCommunicationApp(app: string): boolean {
  const a = app.toLowerCase();
  return COMMUNICATION_APPS.some((name) => a.includes(name));
}

function isBrowser(app: string): boolean {
  const a = app.toLowerCase();
  return BROWSERS.some((b) => a.includes(b));
}

/**
 * Classify a frame into a conversation bucket.
 *
 * Precedence: native comms app → browser-based channel → generic. Native first
 * keeps a desktop WhatsApp/Teams app under its real name rather than a "(web)"
 * label. Title matching is gated on the app being a browser so that, e.g., a
 * `whatsapp.ts` file open in an editor is never mistaken for a conversation.
 */
export function classifyChannel(c: FrameContent): ChannelClassification {
  const app = (c.app_name ?? "Unknown").trim() || "Unknown";
  if (isCommunicationApp(app)) return { bucketKey: app, isComms: true };

  const url = (c.browser_url ?? "").toLowerCase();
  const title = `${c.window_name ?? ""} ${c.window_title ?? ""}`.toLowerCase();
  const browser = isBrowser(app);
  for (const ch of BROWSER_CHANNELS) {
    const urlHit = url !== "" && ch.urlPatterns.some((p) => url.includes(p));
    const titleHit = browser && ch.titlePatterns.some((p) => title.includes(p));
    if (urlHit || titleHit) return { bucketKey: ch.display, isComms: true };
  }

  return { bucketKey: app, isComms: false };
}
