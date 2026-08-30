// atlas.ts — client + enrichment helpers for the Atlas capture backend.
//
// The bb plugin ("Atlas") is a *consumer* of the standalone Atlas backend that
// runs on omni behind atlas.notpritam.in. This module is pure (no bb SDK): a
// thin HTTP client plus the prompt/parse helpers the enrichment worker uses.
// Types mirror @atlas/shared (the backend's contract) but are vendored here
// because the plugin lives in a separate repo.

export interface AtlasConfig {
  baseUrl: string;
  token: string;
}

export type CaptureType =
  | "screenshot"
  | "image"
  | "highlight"
  | "bookmark"
  | "note";
export type CaptureStatus = "pending" | "processing" | "done" | "failed";

export interface Association {
  targetId?: string | null;
  title?: string | null;
  reason?: string | null;
}

export interface AtlasCapture {
  id: string;
  type: CaptureType;
  status: CaptureStatus;
  sourceUrl: string | null;
  sourceTitle: string | null;
  faviconUrl: string | null;
  selectionText: string | null;
  selectionContext: { paragraph?: string | null; anchor?: string | null } | null;
  noteText: string | null;
  blobMime: string | null;
  blobBytes: number | null;
  width: number | null;
  height: number | null;
  hasBlob: boolean;
  hasThumb: boolean;
  ocrText: string | null;
  description: string | null;
  summary: string | null;
  category: string | null;
  tags: string[];
  associations: Association[];
  articleText: string | null;
  lang: string | null;
  model: string | null;
  enrichError: string | null;
  enrichAttempts: number;
  deviceId: string | null;
  capturedAt: number | null;
  createdAt: number;
  updatedAt: number;
  enrichedAt: number | null;
}

export interface Enrichment {
  ocrText?: string;
  description?: string;
  summary?: string;
  category?: string;
  tags?: string[];
  associations?: Association[];
  articleText?: string;
  lang?: string;
  model?: string;
  status?: "done" | "failed";
  error?: string;
}

export interface FacetCount {
  name: string;
  count: number;
}

export interface ListParams {
  type?: string | null;
  status?: string | null;
  tag?: string | null;
  category?: string | null;
  q?: string | null;
  cursor?: string | null;
  limit?: number | null;
}

async function req(
  cfg: AtlasConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.token}` };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return fetch(`${cfg.baseUrl}${path}`, { method, headers, body: payload });
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`atlas ${res.status} ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

// ----- queries used by RPC + the worker -----------------------------------

export async function listCaptures(
  cfg: AtlasConfig,
  p: ListParams,
): Promise<{ captures: AtlasCapture[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v !== null && v !== undefined && v !== "") qs.set(k, String(v));
  }
  return json(await req(cfg, "GET", `/v1/captures?${qs.toString()}`));
}

export async function getCapture(
  cfg: AtlasConfig,
  id: string,
): Promise<AtlasCapture | null> {
  const res = await req(cfg, "GET", `/v1/captures/${id}`);
  if (res.status === 404) return null;
  return json(res);
}

export async function patchCapture(
  cfg: AtlasConfig,
  id: string,
  patch: Record<string, unknown>,
): Promise<AtlasCapture | null> {
  const res = await req(cfg, "PATCH", `/v1/captures/${id}`, patch);
  if (res.status === 404) return null;
  return json(res);
}

export async function deleteCapture(cfg: AtlasConfig, id: string): Promise<boolean> {
  const res = await req(cfg, "DELETE", `/v1/captures/${id}`);
  return res.ok;
}

export async function listFacets(
  cfg: AtlasConfig,
): Promise<{ tags: FacetCount[]; categories: FacetCount[] }> {
  const [t, c] = await Promise.all([
    json<{ tags: FacetCount[] }>(await req(cfg, "GET", "/v1/tags")),
    json<{ categories: FacetCount[] }>(await req(cfg, "GET", "/v1/categories")),
  ]);
  return { tags: t.tags, categories: c.categories };
}

export async function claimCaptures(
  cfg: AtlasConfig,
  owner: string,
  limit: number,
): Promise<AtlasCapture[]> {
  const res = await req(cfg, "POST", "/v1/captures/claim", { owner, limit });
  const body = await json<{ captures: AtlasCapture[] }>(res);
  return body.captures;
}

export async function patchEnrichment(
  cfg: AtlasConfig,
  id: string,
  result: Enrichment,
): Promise<void> {
  const res = await req(cfg, "PATCH", `/v1/captures/${id}/enrichment`, result);
  if (!res.ok) throw new Error(`atlas enrichment ${res.status}`);
}

/** Raw blob/thumb response, for proxying through the plugin's http route. */
export async function fetchBlob(
  cfg: AtlasConfig,
  id: string,
  which: "blob" | "thumb",
  range?: string,
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.token}` };
  if (range) headers.range = range;
  return fetch(`${cfg.baseUrl}/v1/captures/${id}/${which}`, { headers });
}

/** Blob bytes for handing a screenshot to a vision agent thread. */
export async function fetchBlobBytes(
  cfg: AtlasConfig,
  id: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await fetchBlob(cfg, id, "blob");
  if (!res.ok) throw new Error(`atlas blob ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return { bytes: buf, mime: res.headers.get("content-type") ?? "application/octet-stream" };
}

// ----- enrichment prompts + parsing ---------------------------------------

const JSON_TAIL =
  `"summary" (one short line), "category" (a single lowercase bucket like ` +
  `'design','code','article','receipt','social','reference','docs'), ` +
  `"tags" (2-5 lowercase, hyphenated, reusable concepts — no '#'), ` +
  `"associations" ([]).`;

export function imagePrompt(c: AtlasCapture): string {
  const ctx = [c.sourceTitle && `page title: ${c.sourceTitle}`, c.sourceUrl && `url: ${c.sourceUrl}`]
    .filter(Boolean)
    .join(", ");
  return (
    `You are organizing a saved screenshot for a personal knowledge base. ` +
    `Look at the image and return ONLY minified JSON with keys: ` +
    `"ocrText" (all readable text in the image, or ""), ` +
    `"description" (1-2 sentences on what the image shows), ` +
    JSON_TAIL +
    (ctx ? `\nContext: ${ctx}.` : "")
  );
}

export function textPrompt(c: AtlasCapture): string {
  const content =
    c.type === "bookmark"
      ? (c.articleText ?? c.sourceTitle ?? c.sourceUrl ?? "")
      : (c.selectionText ?? c.noteText ?? c.sourceTitle ?? "");
  const src = [c.sourceTitle && `title: ${c.sourceTitle}`, c.sourceUrl && `url: ${c.sourceUrl}`]
    .filter(Boolean)
    .join(", ");
  return (
    `You are organizing a saved ${c.type} for a personal knowledge base. ` +
    `Return ONLY minified JSON with keys: ` +
    JSON_TAIL +
    `\n${c.type} content: ${JSON.stringify(String(content).slice(0, 4000))}` +
    (src ? `\nSource: ${src}.` : "")
  );
}

/** Best-effort parse of an agent's JSON reply into an Enrichment. */
export function parseEnrichment(output: string): Enrichment | null {
  const m = output.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const tags = Array.isArray(j.tags)
    ? j.tags
        .map((t) => String(t).trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-"))
        .filter(Boolean)
        .slice(0, 6)
    : undefined;
  const associations = Array.isArray(j.associations)
    ? (j.associations as Association[]).filter((a) => a && (a.targetId || a.title))
    : undefined;
  return {
    ocrText: str(j.ocrText),
    description: str(j.description),
    summary: str(j.summary),
    category: str(j.category)?.trim().toLowerCase(),
    tags,
    associations,
  };
}
