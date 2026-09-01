// Data access for Atlas "initiatives" — a project/idea/effort that groups tasks,
// carries a state, a timeline of updates, links and linked chats.
//
// Pure functions over a better-sqlite3 handle (same contract as tasks.ts):
// server.ts owns the SDK wiring. Tasks belong to an initiative via
// tasks.initiative_id; chats link many-to-many via initiative_threads.
import type Database from "better-sqlite3";
import { normalizeTags, parseTags, serializeTags, type TaskRow } from "./tasks";

/** Lifecycle state of an initiative — also the board's columns. */
export type InitiativeStatus = "idea" | "active" | "paused" | "shipped";
export const INITIATIVE_STATUSES: readonly InitiativeStatus[] = [
  "idea",
  "active",
  "paused",
  "shipped",
];

/** A timestamped progress update (optionally capturing the state at the time). */
export interface InitiativeUpdate {
  id: string;
  text: string;
  at: number; // ms epoch
  status?: InitiativeStatus | null; // state when the update was posted
}

/** One entry in an initiative's change log. */
export interface InitiativeActivity {
  at: number;
  type: string; // created | edited | status | update | archived | unarchived | linked-thread
}

export interface InitiativeRow {
  id: string;
  seq: number;
  title: string;
  description: string | null;
  status: InitiativeStatus;
  color: string | null; // optional accent hint
  tags: string | null; // JSON array
  links: string | null; // JSON array of URLs
  updates: string | null; // JSON array of { id, text, at, status? }
  created_at: number;
  updated_at: number;
  activity: string | null; // JSON array of { at, type }
  archived_at: number | null;
}

// ---------------------------------------------------------------------------
// ids / seq
// ---------------------------------------------------------------------------

function newId(): string {
  return `initiative_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function nextSeq(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM initiatives`)
    .get() as { next: number };
  return row.next;
}

// ---------------------------------------------------------------------------
// activity log
// ---------------------------------------------------------------------------

export function logInitiativeActivity(
  db: Database.Database,
  id: string,
  type: string,
  now: number = Date.now(),
): void {
  const row = getInitiativeById(db, id);
  if (!row) return;
  let arr: InitiativeActivity[] = [];
  if (row.activity) {
    try {
      const j = JSON.parse(row.activity);
      if (Array.isArray(j)) arr = j;
    } catch {
      /* ignore */
    }
  }
  arr.push({ at: now, type });
  if (arr.length > 80) arr = arr.slice(arr.length - 80);
  db.prepare(
    `UPDATE initiatives SET updated_at = ?, activity = ? WHERE id = ?`,
  ).run(now, JSON.stringify(arr), id);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface NewInitiativeInput {
  title: string;
  description?: string | null;
  status?: InitiativeStatus;
  tags?: string[] | null;
  links?: string[] | null;
  color?: string | null;
}

export function insertInitiative(
  db: Database.Database,
  input: NewInitiativeInput,
  now: number = Date.now(),
): InitiativeRow {
  const id = newId();
  const seq = nextSeq(db);
  db.prepare(
    `INSERT INTO initiatives (id, seq, title, description, status, color, tags, links, updates, created_at, updated_at, activity, archived_at)
     VALUES (@id, @seq, @title, @description, @status, @color, @tags, @links, NULL, @now, @now, @activity, NULL)`,
  ).run({
    id,
    seq,
    title: input.title,
    description: input.description ?? null,
    status: input.status ?? "idea",
    color: input.color ?? null,
    tags: input.tags && input.tags.length ? serializeTags(input.tags) : null,
    links:
      input.links && input.links.length
        ? JSON.stringify([...new Set(input.links.filter(Boolean))])
        : null,
    now,
    activity: JSON.stringify([{ at: now, type: "created" }]),
  });
  return getInitiativeById(db, id)!;
}

export function getInitiativeById(
  db: Database.Database,
  id: string,
): InitiativeRow | undefined {
  return db.prepare(`SELECT * FROM initiatives WHERE id = ?`).get(id) as
    | InitiativeRow
    | undefined;
}

export function getInitiativeBySeq(
  db: Database.Database,
  seq: number,
): InitiativeRow | undefined {
  return db.prepare(`SELECT * FROM initiatives WHERE seq = ?`).get(seq) as
    | InitiativeRow
    | undefined;
}

/** Resolve an initiative by seq number, exact id, or an id prefix. */
export function resolveInitiative(
  db: Database.Database,
  ref: string,
): InitiativeRow | undefined {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return getInitiativeBySeq(db, Number(trimmed));
  const exact = getInitiativeById(db, trimmed);
  if (exact) return exact;
  const hits = db
    .prepare(`SELECT * FROM initiatives WHERE id LIKE ? LIMIT 2`)
    .all(`${trimmed}%`) as InitiativeRow[];
  return hits.length === 1 ? hits[0] : undefined;
}

export function listInitiatives(
  db: Database.Database,
  opts: { status?: InitiativeStatus | null; includeArchived?: boolean } = {},
): InitiativeRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeArchived) where.push("archived_at IS NULL");
  else where.push("archived_at IS NOT NULL"); // includeArchived => ONLY archived
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  const sql = `SELECT * FROM initiatives${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY (archived_at IS NULL) DESC, updated_at DESC`;
  return db.prepare(sql).all(...params) as InitiativeRow[];
}

export interface InitiativePatch {
  title?: string;
  description?: string | null;
  status?: InitiativeStatus;
  tags?: string[] | null;
  links?: string[] | null;
  color?: string | null;
  updates?: InitiativeUpdate[] | null;
}

export function updateInitiative(
  db: Database.Database,
  id: string,
  patch: InitiativePatch,
  now: number = Date.now(),
): InitiativeRow | undefined {
  const cur = getInitiativeById(db, id);
  if (!cur) return undefined;
  db.prepare(
    `UPDATE initiatives SET title = @title, description = @description, status = @status, color = @color, tags = @tags, links = @links, updates = @updates WHERE id = @id`,
  ).run({
    id,
    title: patch.title ?? cur.title,
    description:
      patch.description === undefined ? cur.description : patch.description,
    status: patch.status ?? cur.status,
    color: patch.color === undefined ? cur.color : patch.color,
    tags:
      patch.tags === undefined
        ? cur.tags
        : patch.tags === null || patch.tags.length === 0
          ? null
          : serializeTags(normalizeTags(patch.tags)),
    links:
      patch.links === undefined
        ? cur.links
        : patch.links === null || patch.links.length === 0
          ? null
          : JSON.stringify([...new Set(patch.links.filter(Boolean))]),
    updates:
      patch.updates === undefined
        ? cur.updates
        : patch.updates === null || patch.updates.length === 0
          ? null
          : JSON.stringify(patch.updates),
  });
  logInitiativeActivity(db, id, patch.status && patch.status !== cur.status ? "status" : "edited", now);
  return getInitiativeById(db, id);
}

/** Post a progress update; records the (optional) state at that moment. */
export function addInitiativeUpdate(
  db: Database.Database,
  id: string,
  text: string,
  status: InitiativeStatus | null | undefined,
  now: number = Date.now(),
): InitiativeRow | undefined {
  const cur = getInitiativeById(db, id);
  if (!cur) return undefined;
  let arr: InitiativeUpdate[] = [];
  if (cur.updates) {
    try {
      const j = JSON.parse(cur.updates);
      if (Array.isArray(j)) arr = j;
    } catch {
      /* ignore */
    }
  }
  arr.push({
    id: `iu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    text,
    at: now,
    status: status ?? cur.status,
  });
  // If the update carries a new state, move the initiative to it.
  const nextStatus = status && status !== cur.status ? status : cur.status;
  db.prepare(
    `UPDATE initiatives SET updates = @updates, status = @status WHERE id = @id`,
  ).run({ id, updates: JSON.stringify(arr), status: nextStatus });
  logInitiativeActivity(db, id, "update", now);
  return getInitiativeById(db, id);
}

export function setInitiativeStatus(
  db: Database.Database,
  id: string,
  status: InitiativeStatus,
  now: number = Date.now(),
): InitiativeRow | undefined {
  if (!getInitiativeById(db, id)) return undefined;
  db.prepare(`UPDATE initiatives SET status = ? WHERE id = ?`).run(status, id);
  logInitiativeActivity(db, id, "status", now);
  return getInitiativeById(db, id);
}

export function setInitiativeArchived(
  db: Database.Database,
  id: string,
  archived: boolean,
  now: number = Date.now(),
): InitiativeRow | undefined {
  if (!getInitiativeById(db, id)) return undefined;
  db.prepare(`UPDATE initiatives SET archived_at = ? WHERE id = ?`).run(
    archived ? now : null,
    id,
  );
  logInitiativeActivity(db, id, archived ? "archived" : "unarchived", now);
  return getInitiativeById(db, id);
}

export function deleteInitiative(db: Database.Database, id: string): boolean {
  db.prepare(`DELETE FROM initiative_threads WHERE initiative_id = ?`).run(id);
  db.prepare(`UPDATE tasks SET initiative_id = NULL WHERE initiative_id = ?`).run(id);
  const info = db.prepare(`DELETE FROM initiatives WHERE id = ?`).run(id);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// tasks under an initiative
// ---------------------------------------------------------------------------

/** Assign (or clear, with null) the initiative a task belongs to. */
export function setTaskInitiative(
  db: Database.Database,
  taskId: string,
  initiativeId: string | null,
): void {
  db.prepare(`UPDATE tasks SET initiative_id = ? WHERE id = ?`).run(
    initiativeId,
    taskId,
  );
}

/** Tasks belonging to an initiative (open first, newest first). */
export function tasksForInitiative(
  db: Database.Database,
  initiativeId: string,
): TaskRow[] {
  return db
    .prepare(
      `SELECT * FROM tasks WHERE initiative_id = ? AND archived_at IS NULL
       ORDER BY (status = 'done') ASC, created_at DESC`,
    )
    .all(initiativeId) as TaskRow[];
}

// ---------------------------------------------------------------------------
// initiative <-> thread links (many-to-many)
// ---------------------------------------------------------------------------

export function linkInitiativeThread(
  db: Database.Database,
  initiativeId: string,
  threadId: string,
  now: number = Date.now(),
): void {
  db.prepare(
    `INSERT OR IGNORE INTO initiative_threads (initiative_id, thread_id, created_at) VALUES (?, ?, ?)`,
  ).run(initiativeId, threadId, now);
}

export function unlinkInitiativeThread(
  db: Database.Database,
  initiativeId: string,
  threadId: string,
): void {
  db.prepare(
    `DELETE FROM initiative_threads WHERE initiative_id = ? AND thread_id = ?`,
  ).run(initiativeId, threadId);
}

export function threadIdsForInitiative(
  db: Database.Database,
  initiativeId: string,
): string[] {
  return (
    db
      .prepare(
        `SELECT thread_id FROM initiative_threads WHERE initiative_id = ? ORDER BY created_at DESC`,
      )
      .all(initiativeId) as { thread_id: string }[]
  ).map((r) => r.thread_id);
}

export function initiativeRowsForThread(
  db: Database.Database,
  threadId: string,
): InitiativeRow[] {
  return db
    .prepare(
      `SELECT i.* FROM initiatives i
       JOIN initiative_threads l ON l.initiative_id = i.id
       WHERE l.thread_id = ?
       ORDER BY l.created_at DESC`,
    )
    .all(threadId) as InitiativeRow[];
}

// ---------------------------------------------------------------------------
// parse helpers (JSON columns -> typed)
// ---------------------------------------------------------------------------

export function parseUpdates(raw: string | null): InitiativeUpdate[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j)
      ? j.map((u: Record<string, unknown>) => ({
          id: String(u.id ?? ""),
          text: String(u.text ?? ""),
          at: Number(u.at ?? 0),
          status: (u.status as InitiativeStatus | null | undefined) ?? null,
        }))
      : [];
  } catch {
    return [];
  }
}

export function parseInitiativeLinks(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.map(String) : [];
  } catch {
    return [];
  }
}

export function parseInitiativeActivity(raw: string | null): InitiativeActivity[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j)
      ? j.map((a: Record<string, unknown>) => ({
          at: Number(a.at ?? 0),
          type: String(a.type ?? ""),
        }))
      : [];
  } catch {
    return [];
  }
}

export { parseTags as parseInitiativeTags };
