/**
 * Uploads a curated activity document to a memory backend — either directly to
 * Assistant Memory or via the Petals proxy. Keyed on document.id; pass
 * `updateExisting` to replace a prior document with the same id (otherwise the
 * backend rejects the re-ingest as a conflict). Retries network/5xx with backoff.
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

export function buildDocument(p: DocPayload) {
  return {
    id: p.id,
    content: p.content,
    contentType: "markdown",
    scope: "personal",
    title: p.title,
    timestamp: p.timestampIso,
  } as const;
}

interface UploadTarget {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export function resolveTarget(p: DocPayload, config: Config, updateExisting: boolean): UploadTarget {
  const document = buildDocument(p);
  if (config.UPLOAD_MODE === "petals") {
    if (!config.PETALS_API_KEY) {
      throw new UploadError("PETALS_API_KEY is required for UPLOAD_MODE=petals");
    }
    return {
      url: `${config.PETALS_BASE_URL}/api/memory/ingest/document`,
      headers: { "Content-Type": "application/json", "x-api-key": config.PETALS_API_KEY },
      body: { document, updateExisting },
    };
  }
  if (!config.MEMORY_USER_ID) {
    throw new UploadError("MEMORY_USER_ID is required for UPLOAD_MODE=direct");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.MEMORY_API_KEY) headers["Authorization"] = `Bearer ${config.MEMORY_API_KEY}`;
  return {
    url: `${config.MEMORY_API_URL}/ingest/document`,
    headers,
    body: { userId: config.MEMORY_USER_ID, document, updateExisting },
  };
}

interface UploadDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export async function uploadDocument(
  p: DocPayload,
  config: Config,
  updateExisting: boolean,
  deps: UploadDeps = {},
): Promise<{ jobId: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const { url, headers, body } = resolveTarget(p, config, updateExisting);
  const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };

  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      lastErr = e;
    }
    if (res) {
      if (res.ok) return { jobId: uploadResponseSchema.parse(await res.json()).jobId };
      const text = await res.text();
      if (res.status >= 400 && res.status < 500) {
        throw new UploadError(`upload rejected ${res.status}: ${text}`);
      }
      lastErr = new UploadError(`upload failed ${res.status}: ${text}`);
    }
    if (attempt < maxAttempts) await sleep(250 * 2 ** attempt);
  }
  throw lastErr instanceof Error ? lastErr : new UploadError("upload failed after retries");
}
