/**
 * Uploads a curated activity document to Assistant Memory via the hosted
 * Petals proxy. Idempotent on document.id; retries network/5xx with backoff.
 */
import { z } from "zod";
import type { Config } from "./config";

export class UploadError extends Error {}

export interface DocPayload {
  id: string;
  content: string;
  title: string;
  timestampIso: string;
}

const uploadResponseSchema = z.object({ message: z.string(), jobId: z.string() }).passthrough();

export function buildDocumentBody(p: DocPayload) {
  return {
    document: {
      id: p.id,
      content: p.content,
      contentType: "markdown",
      scope: "personal",
      title: p.title,
      timestamp: p.timestampIso,
    },
  } as const;
}

interface UploadDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export async function uploadDocument(p: DocPayload, config: Config, deps: UploadDeps = {}): Promise<{ jobId: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url = `${config.PETALS_BASE_URL}/api/memory/ingest/document`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.PETALS_API_KEY },
    body: JSON.stringify(buildDocumentBody(p)),
  };

  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      lastErr = e; // network error → retry
    }
    if (res) {
      if (res.ok) return { jobId: uploadResponseSchema.parse(await res.json()).jobId };
      const text = await res.text();
      if (res.status >= 400 && res.status < 500) {
        throw new UploadError(`Petals rejected upload ${res.status}: ${text}`);
      }
      lastErr = new UploadError(`Petals upload failed ${res.status}: ${text}`); // 5xx → retry
    }
    if (attempt < maxAttempts) await sleep(250 * 2 ** attempt);
  }
  throw lastErr instanceof Error ? lastErr : new UploadError("upload failed after retries");
}
