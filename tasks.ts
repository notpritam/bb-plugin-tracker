// Data access + date logic for the Tracker plugin.
//
// Pure functions over a better-sqlite3 handle so the query/rollover logic is
// unit-testable without a running BB. server.ts owns wiring (RPC, CLI,
// realtime) and resolves project names via bb.sdk; this module never touches
// the SDK.
import type Database from "better-sqlite3";

export type TaskStatus = "open" | "done";
export type TaskView = "today" | "upcoming" | "all" | "done";

/** Raw row as stored in the `tasks` table. */
export interface TaskRow {
  id: string;
  seq: number;
  title: string;
  status: TaskStatus;
  project_id: string | null;
  notes: string | null;
  due_date: string | null; // YYYY-MM-DD
  created_at: number; // ms epoch
  done_at: number | null; // ms epoch
  tags: string | null; // JSON array of strings
  link: string | null;
  sort_order: number | null; // manual ordering (fractional)
  completion: string | null; // "what we did" write-up attached on close
  urgent: number; // 0/1 — flagged for focus; floats to the top and is highlighted
}

// ---------------------------------------------------------------------------
// Tag helpers (pure)
// ---------------------------------------------------------------------------

/** Parse the stored tags JSON into a clean, deduped, lowercased list. */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return normalizeTags(arr.map(String));
  } catch {
    return [];
  }
}

/** Normalize a tag list: trim, drop leading '#', lowercase, dedupe, non-empty. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const clean = t.trim().replace(/^#/, "").toLowerCase();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

export function serializeTags(tags: string[]): string | null {
  const n = normalizeTags(tags);
  return n.length ? JSON.stringify(n) : null;
}

/** The append-only migration set. Never reorder or edit shipped statements. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tasks (
     id         TEXT PRIMARY KEY,
     seq        INTEGER NOT NULL UNIQUE,
     title      TEXT NOT NULL,
     status     TEXT NOT NULL DEFAULT 'open',
     project_id TEXT,
     notes      TEXT,
     due_date   TEXT,
     created_at INTEGER NOT NULL,
     done_at    INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks (due_date)`,
  // v2: tags, link, and manual ordering.
  `ALTER TABLE tasks ADD COLUMN tags TEXT`,
  `ALTER TABLE tasks ADD COLUMN link TEXT`,
  `ALTER TABLE tasks ADD COLUMN sort_order REAL`,
  `UPDATE tasks SET sort_order = seq WHERE sort_order IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks (sort_order)`,
  // v3: a completion write-up attached when a task is closed (what we did, PRs).
  `ALTER TABLE tasks ADD COLUMN completion TEXT`,
];

// ---------------------------------------------------------------------------
// Date helpers (server-local time)
// ---------------------------------------------------------------------------

/** Local calendar date (YYYY-MM-DD) for a ms-epoch timestamp. */
export function localDateString(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today's local calendar date. */
export function todayString(now: number = Date.now()): string {
  return localDateString(now);
}

/** Midnight (local) at the start of today, as ms epoch. */
export function startOfTodayMs(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Add `n` days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  // Noon avoids any DST edge landing on the wrong day.
  const dt = new Date(y, m - 1, d + n, 12, 0, 0, 0);
  return localDateString(dt.getTime());
}

/**
 * Parse a user-supplied date into YYYY-MM-DD. Accepts an ISO date, the words
 * `today`/`tomorrow`, or a relative `+Nd` / `+N` offset. Throws on anything
 * else so callers can surface a clear error.
 */
export function parseDueDate(input: string, now: number = Date.now()): string {
  const raw = input.trim();
  const s = raw.toLowerCase();
  if (s === "today") return todayString(now);
  if (s === "tomorrow") return addDays(todayString(now), 1);
  const rel = s.match(/^\+(\d+)d?$/);
  if (rel) return addDays(todayString(now), Number(rel[1]));
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    const month = Number(m);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error(`Invalid date "${raw}".`);
    }
    return raw;
  }
  throw new Error(
    `Invalid date "${raw}". Use YYYY-MM-DD, today, tomorrow, or +Nd.`,
  );
}

// ---------------------------------------------------------------------------
// Free-text quick-add parsing (pure, instant — no LLM)
// ---------------------------------------------------------------------------

export interface ParsedInput {
  title: string;
  tags: string[];
  dueDate: string | null;
  link: string | null;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

/** Days from today (local) until the next occurrence of a weekday (1..7). */
function daysUntilWeekday(target: number, now: number): number {
  const cur = new Date(now).getDay();
  const diff = (target - cur + 7) % 7;
  return diff === 0 ? 7 : diff;
}

/**
 * Extract tags (#tag), the first URL, and a due date from free text, leaving a
 * clean title. Recognizes: today, tomorrow, +Nd, YYYY-MM-DD, and weekday names
 * (next occurrence). Whatever it can't classify stays in the title.
 */
export function localParse(text: string, now: number = Date.now()): ParsedInput {
  let s = ` ${text.trim()} `;

  // Link — first http(s) URL.
  const urlMatch = s.match(/https?:\/\/[^\s]+/i);
  const link = urlMatch ? urlMatch[0].replace(/[).,]+$/, "") : null;
  if (link) s = s.replace(link, " ");

  // Tags — #word.
  const tags: string[] = [];
  s = s.replace(/#([\p{L}\p{N}_-]+)/gu, (_m, t: string) => {
    tags.push(t);
    return " ";
  });

  // Due date — try, in order: YYYY-MM-DD, today/tomorrow, +Nd, weekday.
  let dueDate: string | null = null;
  const iso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    try {
      dueDate = parseDueDate(iso[1], now);
      s = s.replace(iso[1], " ");
    } catch {
      /* leave in title */
    }
  }
  if (!dueDate) {
    const rel = s.match(/(?:^|\s)(today|tomorrow|tmrw|\+\d+d?)(?=\s)/i);
    if (rel) {
      const tok = rel[1].toLowerCase().replace("tmrw", "tomorrow");
      try {
        dueDate = parseDueDate(tok, now);
        s = s.replace(rel[1], " ");
      } catch {
        /* ignore */
      }
    }
  }
  if (!dueDate) {
    const wd = s.match(
      /(?:^|\s)(?:by\s+|on\s+|next\s+)?([a-z]+)(?=\s)/i,
    );
    if (wd) {
      const key = wd[1].toLowerCase();
      if (key in WEEKDAYS) {
        dueDate = addDays(todayString(now), daysUntilWeekday(WEEKDAYS[key], now));
        // Remove the weekday token (and a leading by/on/next) from the title.
        s = s.replace(new RegExp(`(by |on |next )?${wd[1]}`, "i"), " ");
      }
    }
  }

  const title = s.replace(/\s{2,}/g, " ").trim();
  return {
    title: title || text.trim(),
    tags: normalizeTags(tags),
    dueDate,
    link,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function newId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nextSeq(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tasks`)
    .get() as { next: number };
  return row.next;
}

export interface NewTaskInput {
  title: string;
  projectId?: string | null;
  notes?: string | null;
  dueDate?: string | null;
  tags?: string[] | null;
  link?: string | null;
}

/** Next fractional sort_order — appends after the current maximum. */
function nextSortOrder(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM tasks`)
    .get() as { next: number };
  return row.next;
}

export function insertTask(
  db: Database.Database,
  input: NewTaskInput,
  now: number = Date.now(),
): TaskRow {
  const id = newId();
  const seq = nextSeq(db);
  db.prepare(
    `INSERT INTO tasks (id, seq, title, status, project_id, notes, due_date, created_at, done_at, tags, link, sort_order)
     VALUES (@id, @seq, @title, 'open', @project_id, @notes, @due_date, @created_at, NULL, @tags, @link, @sort_order)`,
  ).run({
    id,
    seq,
    title: input.title,
    project_id: input.projectId ?? null,
    notes: input.notes ?? null,
    due_date: input.dueDate ?? null,
    created_at: now,
    tags: input.tags ? serializeTags(input.tags) : null,
    link: input.link ?? null,
    sort_order: nextSortOrder(db),
  });
  return getTaskById(db, id)!;
}

export function getTaskById(
  db: Database.Database,
  id: string,
): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
    | TaskRow
    | undefined;
}

export function getTaskBySeq(
  db: Database.Database,
  seq: number,
): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE seq = ?`).get(seq) as
    | TaskRow
    | undefined;
}

/**
 * Resolve a task by the reference a user types: a bare number is a `seq`
 * (`#4`), otherwise it is matched as an id (exact, then unique prefix).
 */
export function resolveTask(
  db: Database.Database,
  ref: string,
): TaskRow | undefined {
  const trimmed = ref.trim().replace(/^#/, "");
  if (/^\d+$/.test(trimmed)) {
    return getTaskBySeq(db, Number(trimmed));
  }
  const exact = getTaskById(db, trimmed);
  if (exact) return exact;
  const matches = db
    .prepare(`SELECT * FROM tasks WHERE id LIKE ? LIMIT 2`)
    .all(`${trimmed}%`) as TaskRow[];
  return matches.length === 1 ? matches[0] : undefined;
}

export function setStatus(
  db: Database.Database,
  id: string,
  status: TaskStatus,
  now: number = Date.now(),
): TaskRow | undefined {
  db.prepare(`UPDATE tasks SET status = ?, done_at = ? WHERE id = ?`).run(
    status,
    status === "done" ? now : null,
    id,
  );
  return getTaskById(db, id);
}

export interface TaskPatch {
  title?: string;
  notes?: string | null;
  dueDate?: string | null;
  projectId?: string | null;
  tags?: string[] | null;
  link?: string | null;
  completion?: string | null;
  urgent?: boolean;
}

/**
 * Close a task: mark it done and (optionally) attach a completion write-up.
 * Passing `completion === undefined` leaves any existing write-up untouched.
 */
export function closeTask(
  db: Database.Database,
  id: string,
  completion: string | null | undefined,
  now: number = Date.now(),
): TaskRow | undefined {
  const current = getTaskById(db, id);
  if (!current) return undefined;
  db.prepare(
    `UPDATE tasks SET status = 'done', done_at = @done_at, completion = @completion WHERE id = @id`,
  ).run({
    id,
    done_at: now,
    completion: completion === undefined ? current.completion : completion,
  });
  return getTaskById(db, id);
}

export function updateTask(
  db: Database.Database,
  id: string,
  patch: TaskPatch,
): TaskRow | undefined {
  const current = getTaskById(db, id);
  if (!current) return undefined;
  db.prepare(
    `UPDATE tasks SET title = @title, notes = @notes, due_date = @due_date, project_id = @project_id, tags = @tags, link = @link, completion = @completion, urgent = @urgent WHERE id = @id`,
  ).run({
    id,
    title: patch.title ?? current.title,
    notes: patch.notes === undefined ? current.notes : patch.notes,
    due_date: patch.dueDate === undefined ? current.due_date : patch.dueDate,
    project_id:
      patch.projectId === undefined ? current.project_id : patch.projectId,
    tags:
      patch.tags === undefined
        ? current.tags
        : patch.tags === null
          ? null
          : serializeTags(patch.tags),
    link: patch.link === undefined ? current.link : patch.link,
    completion:
      patch.completion === undefined ? current.completion : patch.completion,
    urgent:
      patch.urgent === undefined ? current.urgent : patch.urgent ? 1 : 0,
  });
  return getTaskById(db, id);
}

/**
 * Move a task within the manual order. `beforeId` is the task it should sit
 * directly above; `afterId` is the task it should sit directly below (use one).
 * Renumbers every open task to a clean 0..n-1 sequence so there are never ties
 * and the new order always sticks.
 */
export function reorderTask(
  db: Database.Database,
  draggedId: string,
  afterId: string | null,
  beforeId: string | null,
): TaskRow | undefined {
  const rows = db
    .prepare(
      `SELECT id FROM tasks WHERE status = 'open'
       ORDER BY COALESCE(sort_order, seq) ASC, seq ASC`,
    )
    .all() as { id: string }[];
  const ids = rows.map((r) => r.id).filter((id) => id !== draggedId);

  let idx: number;
  if (beforeId) {
    const i = ids.indexOf(beforeId);
    idx = i < 0 ? ids.length : i;
  } else if (afterId) {
    const i = ids.indexOf(afterId);
    idx = i < 0 ? ids.length : i + 1;
  } else {
    idx = ids.length;
  }
  ids.splice(idx, 0, draggedId);

  const upd = db.prepare(`UPDATE tasks SET sort_order = ? WHERE id = ?`);
  db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
  return getTaskById(db, draggedId);
}

/** All distinct tags currently in use, sorted. */
export function distinctTags(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT tags FROM tasks WHERE tags IS NOT NULL`)
    .all() as { tags: string }[];
  const set = new Set<string>();
  for (const r of rows) for (const t of parseTags(r.tags)) set.add(t);
  return [...set].sort();
}

export function deleteTask(db: Database.Database, id: string): boolean {
  const info = db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
  return info.changes > 0;
}

/**
 * Query tasks for a view. Auto-rollover is implicit: an open task with no
 * future due date always appears in `today`, regardless of when it was added.
 */
export interface TaskFilters {
  tag?: string | null;
  search?: string | null;
}

export function queryTasks(
  db: Database.Database,
  view: TaskView,
  projectId: string | null | undefined,
  filters: TaskFilters = {},
  now: number = Date.now(),
): TaskRow[] {
  const today = todayString(now);
  const startToday = startOfTodayMs(now);
  const projClause =
    projectId === undefined || projectId === null
      ? ""
      : ` AND project_id = @projectId`;
  const tagClause = filters.tag ? ` AND tags LIKE @tagLike` : "";
  const searchClause = filters.search ? ` AND title LIKE @searchLike` : "";
  const params = {
    today,
    startToday,
    projectId: projectId ?? null,
    tagLike: filters.tag ? `%"${filters.tag.toLowerCase()}"%` : null,
    searchLike: filters.search ? `%${filters.search}%` : null,
  };
  const extra = projClause + tagClause + searchClause;

  // Manual sort_order is the primary order for open-task views so drag-to-
  // reorder sticks; done stays newest-first.
  let sql: string;
  switch (view) {
    case "today":
      sql = `SELECT * FROM tasks
             WHERE ((status = 'open' AND (due_date IS NULL OR due_date <= @today))
                    OR (status = 'done' AND done_at >= @startToday))${extra}
             ORDER BY (status = 'done') ASC,
                      (urgent = 1 AND status = 'open') DESC,
                      COALESCE(sort_order, seq) ASC`;
      break;
    case "upcoming":
      sql = `SELECT * FROM tasks
             WHERE status = 'open' AND due_date > @today${extra}
             ORDER BY urgent DESC, due_date ASC, COALESCE(sort_order, seq) ASC`;
      break;
    case "all":
      sql = `SELECT * FROM tasks
             WHERE status = 'open'${extra}
             ORDER BY urgent DESC, COALESCE(sort_order, seq) ASC`;
      break;
    case "done":
      sql = `SELECT * FROM tasks
             WHERE status = 'done'${extra}
             ORDER BY done_at DESC, seq DESC`;
      break;
  }
  return db.prepare(sql).all(params) as TaskRow[];
}
