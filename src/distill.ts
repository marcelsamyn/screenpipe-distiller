/**
 * Orchestrates one day's distillation: fetch → curate → upload.
 * Seams are injectable for testing; defaults wire the real implementations.
 */
import type { Config } from "./config";
import type { Conversation, CuratedDoc, DayDigest } from "./types";
import { ScreenpipeClient, fetchDayActivity } from "./screenpipe";
import { curateDigest } from "./curate";
import { uploadDocument, type DocPayload } from "./upload";
import { loadWhatsAppConversations } from "./whatsapp/conversations";

export interface DistillDeps {
  fetchDay: (dayKey: string) => Promise<DayDigest>;
  curate: (digest: DayDigest) => Promise<CuratedDoc>;
  upload: (p: DocPayload) => Promise<{ jobId: string }>;
}

function defaultDeps(config: Config): DistillDeps {
  const client = new ScreenpipeClient(config.SCREENPIPE_API_URL, config.SCREENPIPE_API_KEY);
  const loadConversations =
    config.WHATSAPP_CONNECTOR === "off"
      ? undefined
      : async (startIso: string, endIso: string): Promise<Conversation[]> => {
          try {
            return loadWhatsAppConversations({
              archivePath: config.WHATSAPP_ARCHIVE_PATH,
              startUnix: Math.floor(Date.parse(startIso) / 1000),
              endUnix: Math.floor(Date.parse(endIso) / 1000),
              groupFilter: config.WHATSAPP_GROUP_FILTER,
            });
          } catch (error) {
            console.warn(
              `[whatsapp] archive read failed (${config.WHATSAPP_ARCHIVE_PATH}); continuing screen-only:`,
              error,
            );
            return [];
          }
        };
  return {
    fetchDay: (dayKey) => fetchDayActivity(client, dayKey, config.USER_TIMEZONE, loadConversations),
    curate: (digest) => curateDigest(digest, config),
    upload: (p) => uploadDocument(p, config),
  };
}

export async function runDistill(
  dayKey: string,
  config: Config,
  deps: DistillDeps = defaultDeps(config),
  options: { dryRun?: boolean } = {},
): Promise<{ jobId: string | null; isEmptyDay: boolean; markdown: string }> {
  const digest = await deps.fetchDay(dayKey);
  const doc = await deps.curate(digest);
  if (options.dryRun) {
    return { jobId: null, isEmptyDay: doc.isEmptyDay, markdown: doc.markdown };
  }
  const { jobId } = await deps.upload({
    id: `screenpipe-activity-${dayKey}`,
    content: doc.markdown,
    title: `Computer activity — ${dayKey}`,
    timestampIso: `${dayKey}T12:00:00Z`,
  });
  return { jobId, isEmptyDay: doc.isEmptyDay, markdown: doc.markdown };
}
