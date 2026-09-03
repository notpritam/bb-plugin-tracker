// Data access for Atlas "Practice" — a personal learning / spaced-repetition
// system: everything you're studying (system design, frontend, coding problems,
// concepts, flashcards) with a daily review queue so you improve day by day.
//
// Pure functions over a better-sqlite3 handle (same contract as tasks.ts).
// Scheduling is a simplified SM-2 (Anki-style) with 4 grades.
import type Database from "better-sqlite3";
import { normalizeTags, parseTags, serializeTags } from "./tasks";

export type PracticeKind =
  | "concept"
  | "coding"
  | "system-design"
  | "frontend"
  | "flashcard"
  | "other";
export const PRACTICE_KINDS: readonly PracticeKind[] = [
  "concept",
  "coding",
  "system-design",
  "frontend",
  "flashcard",
  "other",
];

export type PracticeStatus = "new" | "learning" | "review" | "mastered";
export type Difficulty = "easy" | "medium" | "hard";
/** Review grade — how well recall went. */
export type Grade = "again" | "hard" | "good" | "easy";

export interface ReviewLogEntry {
  at: number;
  grade: Grade;
  intervalDays: number; // interval scheduled by this review
}

export interface PracticeItemRow {
  id: string;
  seq: number;
  title: string;
  topic: string | null; // e.g. "System Design", "React", "DSA"
  kind: string; // PracticeKind
  question: string | null; // the prompt / problem (markdown)
  solution: string | null; // the answer / approach / notes (markdown)
  difficulty: string | null; // easy | medium | hard
  source: string | null; // URL / book / where it came from
  note_id: string | null; // the Atlas note this was generated from / linked to
  tags: string | null; // JSON array
  status: PracticeStatus;
  due_at: number | null; // ms epoch — when it's next due for review
  interval_days: number; // current interval
  ease: number; // ease factor (SM-2), >= 1.3
  reps: number; // successful reviews in a row
  lapses: number; // times forgotten
  last_reviewed_at: number | null;
  review_log: string | null; // JSON array of ReviewLogEntry
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

// ---------------------------------------------------------------------------
// ids / seq / day math
// ---------------------------------------------------------------------------

function newId(): string {
  return `practice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function nextSeq(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM practice_items`)
    .get() as { next: number };
  return row.next;
}
const DAY_MS = 86_400_000;
/** Local YYYY-MM-DD for a ms epoch. */
export function dayString(ms: number = Date.now()): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function endOfTodayMs(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface NewPracticeItem {
  title: string;
  topic?: string | null;
  kind?: PracticeKind | string;
  question?: string | null;
  solution?: string | null;
  difficulty?: Difficulty | string | null;
  source?: string | null;
  noteId?: string | null;
  tags?: string[] | null;
  /** If true, schedule it due now (start learning immediately). */
  dueNow?: boolean;
}

export function insertPracticeItem(
  db: Database.Database,
  input: NewPracticeItem,
  now: number = Date.now(),
): PracticeItemRow {
  const id = newId();
  const seq = nextSeq(db);
  db.prepare(
    `INSERT INTO practice_items
       (id, seq, title, topic, kind, question, solution, difficulty, source, note_id, tags,
        status, due_at, interval_days, ease, reps, lapses, last_reviewed_at, review_log,
        created_at, updated_at, archived_at)
     VALUES
       (@id, @seq, @title, @topic, @kind, @question, @solution, @difficulty, @source, @note_id, @tags,
        'new', @due_at, 0, 2.5, 0, 0, NULL, NULL,
        @now, @now, NULL)`,
  ).run({
    id,
    seq,
    title: input.title.trim(),
    topic: input.topic ?? null,
    kind: input.kind ?? "concept",
    question: input.question ?? null,
    solution: input.solution ?? null,
    difficulty: input.difficulty ?? null,
    source: input.source ?? null,
    note_id: input.noteId ?? null,
    tags: input.tags && input.tags.length ? serializeTags(input.tags) : null,
    due_at: input.dueNow ? now : null,
    now,
  });
  return getPracticeItemById(db, id)!;
}

export function getPracticeItemById(
  db: Database.Database,
  id: string,
): PracticeItemRow | undefined {
  return db.prepare(`SELECT * FROM practice_items WHERE id = ?`).get(id) as
    | PracticeItemRow
    | undefined;
}
export function getPracticeItemBySeq(
  db: Database.Database,
  seq: number,
): PracticeItemRow | undefined {
  return db.prepare(`SELECT * FROM practice_items WHERE seq = ?`).get(seq) as
    | PracticeItemRow
    | undefined;
}
export function resolvePracticeItem(
  db: Database.Database,
  ref: string,
): PracticeItemRow | undefined {
  const t = ref.trim();
  if (/^\d+$/.test(t)) return getPracticeItemBySeq(db, Number(t));
  const exact = getPracticeItemById(db, t);
  if (exact) return exact;
  const hits = db
    .prepare(`SELECT * FROM practice_items WHERE id LIKE ? LIMIT 2`)
    .all(`${t}%`) as PracticeItemRow[];
  if (hits.length === 1) return hits[0];
  const byTitle = db
    .prepare(`SELECT * FROM practice_items WHERE title LIKE ? LIMIT 2`)
    .all(`%${t}%`) as PracticeItemRow[];
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

export interface PracticeFilter {
  topic?: string | null;
  kind?: string | null;
  status?: PracticeStatus | null;
  tag?: string | null;
  search?: string | null;
  includeArchived?: boolean;
}

export function listPracticeItems(
  db: Database.Database,
  filter: PracticeFilter = {},
): PracticeItemRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!filter.includeArchived) where.push("archived_at IS NULL");
  if (filter.topic) { where.push("topic = ?"); params.push(filter.topic); }
  if (filter.kind) { where.push("kind = ?"); params.push(filter.kind); }
  if (filter.status) { where.push("status = ?"); params.push(filter.status); }
  if (filter.search) {
    where.push("(title LIKE ? OR question LIKE ? OR solution LIKE ? OR topic LIKE ?)");
    const q = `%${filter.search}%`;
    params.push(q, q, q, q);
  }
  const sql = `SELECT * FROM practice_items${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY (due_at IS NULL) ASC, due_at ASC, updated_at DESC`;
  let rows = db.prepare(sql).all(...params) as PracticeItemRow[];
  if (filter.tag) {
    const t = filter.tag.replace(/^#/, "").toLowerCase();
    rows = rows.filter((r) => parseTags(r.tags).includes(t));
  }
  return rows;
}

export interface PracticePatch {
  title?: string;
  topic?: string | null;
  kind?: string;
  question?: string | null;
  solution?: string | null;
  difficulty?: string | null;
  source?: string | null;
  noteId?: string | null;
  tags?: string[] | null;
  dueAt?: number | null; // manual reschedule
  status?: PracticeStatus;
}

export function updatePracticeItem(
  db: Database.Database,
  id: string,
  patch: PracticePatch,
  now: number = Date.now(),
): PracticeItemRow | undefined {
  const cur = getPracticeItemById(db, id);
  if (!cur) return undefined;
  db.prepare(
    `UPDATE practice_items SET title=@title, topic=@topic, kind=@kind, question=@question,
       solution=@solution, difficulty=@difficulty, source=@source, note_id=@note_id, tags=@tags,
       due_at=@due_at, status=@status, updated_at=@now WHERE id=@id`,
  ).run({
    id,
    title: patch.title ?? cur.title,
    topic: patch.topic === undefined ? cur.topic : patch.topic,
    kind: patch.kind ?? cur.kind,
    question: patch.question === undefined ? cur.question : patch.question,
    solution: patch.solution === undefined ? cur.solution : patch.solution,
    difficulty: patch.difficulty === undefined ? cur.difficulty : patch.difficulty,
    source: patch.source === undefined ? cur.source : patch.source,
    note_id: patch.noteId === undefined ? cur.note_id : patch.noteId,
    tags:
      patch.tags === undefined
        ? cur.tags
        : patch.tags === null || patch.tags.length === 0
          ? null
          : serializeTags(normalizeTags(patch.tags)),
    due_at: patch.dueAt === undefined ? cur.due_at : patch.dueAt,
    status: patch.status ?? cur.status,
    now,
  });
  return getPracticeItemById(db, id);
}

export function setPracticeArchived(
  db: Database.Database,
  id: string,
  archived: boolean,
  now: number = Date.now(),
): PracticeItemRow | undefined {
  if (!getPracticeItemById(db, id)) return undefined;
  db.prepare(`UPDATE practice_items SET archived_at = ?, updated_at = ? WHERE id = ?`).run(
    archived ? now : null,
    now,
    id,
  );
  return getPracticeItemById(db, id);
}

export function deletePracticeItem(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM practice_items WHERE id = ?`).run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Spaced repetition (simplified SM-2, 4 grades)
// ---------------------------------------------------------------------------

const GRADE_VALUE: Record<Grade, number> = { again: 0, hard: 1, good: 2, easy: 3 };

/** Apply a review grade: reschedule via SM-2 and advance status. */
export function reviewPracticeItem(
  db: Database.Database,
  id: string,
  grade: Grade,
  now: number = Date.now(),
): PracticeItemRow | undefined {
  const cur = getPracticeItemById(db, id);
  if (!cur) return undefined;
  let { interval_days: interval, ease, reps, lapses } = cur;
  const g = GRADE_VALUE[grade];

  if (g === 0) {
    // again — lapse, relearn tomorrow
    lapses += 1;
    reps = 0;
    ease = Math.max(1.3, ease - 0.2);
    interval = 1;
  } else if (g === 1) {
    // hard
    ease = Math.max(1.3, ease - 0.15);
    interval = interval > 0 ? Math.max(1, Math.round(interval * 1.2)) : 1;
    reps += 1;
  } else if (g === 2) {
    // good
    if (reps === 0) interval = 1;
    else if (reps === 1) interval = 3;
    else interval = Math.round(interval * ease);
    reps += 1;
  } else {
    // easy
    ease = ease + 0.15;
    if (reps === 0) interval = 3;
    else interval = Math.round(Math.max(interval, 1) * ease * 1.3);
    reps += 1;
  }
  interval = Math.max(1, interval);
  const status: PracticeStatus =
    interval >= 21 ? "mastered" : reps >= 1 ? "review" : "learning";
  const due_at = now + interval * DAY_MS;

  let log: ReviewLogEntry[] = [];
  if (cur.review_log) {
    try { const j = JSON.parse(cur.review_log); if (Array.isArray(j)) log = j; } catch { /* ignore */ }
  }
  log.push({ at: now, grade, intervalDays: interval });
  if (log.length > 60) log = log.slice(log.length - 60);

  db.prepare(
    `UPDATE practice_items SET interval_days=@interval, ease=@ease, reps=@reps, lapses=@lapses,
       status=@status, due_at=@due_at, last_reviewed_at=@now, review_log=@log, updated_at=@now
     WHERE id=@id`,
  ).run({ id, interval, ease, reps, lapses, status, due_at, now, log: JSON.stringify(log) });
  return getPracticeItemById(db, id);
}

/** Today's queue: items due for review + a capped set of new items. */
export function dueItems(
  db: Database.Database,
  opts: { newLimit?: number; now?: number } = {},
): { due: PracticeItemRow[]; fresh: PracticeItemRow[] } {
  const now = opts.now ?? Date.now();
  const bound = endOfTodayMs(now);
  const due = db
    .prepare(
      `SELECT * FROM practice_items
       WHERE archived_at IS NULL AND status != 'new' AND due_at IS NOT NULL AND due_at <= ?
       ORDER BY due_at ASC`,
    )
    .all(bound) as PracticeItemRow[];
  const fresh = db
    .prepare(
      `SELECT * FROM practice_items
       WHERE archived_at IS NULL AND status = 'new'
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(Math.max(0, opts.newLimit ?? 10)) as PracticeItemRow[];
  return { due, fresh };
}

/** Practice items generated from / linked to a given note. */
export function itemsForNote(db: Database.Database, noteId: string): PracticeItemRow[] {
  return db
    .prepare(
      `SELECT * FROM practice_items WHERE note_id = ? AND archived_at IS NULL ORDER BY created_at ASC`,
    )
    .all(noteId) as PracticeItemRow[];
}

export function distinctTopics(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT topic FROM practice_items WHERE topic IS NOT NULL AND archived_at IS NULL ORDER BY topic`,
      )
      .all() as { topic: string }[]
  ).map((r) => r.topic);
}

// ---------------------------------------------------------------------------
// Daily sessions (the 1-hour habit + streak)
// ---------------------------------------------------------------------------

/** One item's result within a run — the "in depth" record for self-learning. */
export interface RunDetailEntry {
  itemId: string;
  title?: string;
  kind?: string;
  topic?: string;
  grade?: string; // again|hard|good|easy | got|missed
  seconds?: number; // time spent on this item
}

export interface PracticeSessionRow {
  id: string;
  date: string; // YYYY-MM-DD
  minutes: number;
  reviewed: number;
  notes: string | null;
  mode: string | null; // review | drill | coach
  detail: string | null; // JSON RunDetailEntry[]
  created_at: number;
}

export function logSession(
  db: Database.Database,
  input: {
    minutes?: number;
    reviewed?: number;
    notes?: string | null;
    mode?: string | null;
    detail?: RunDetailEntry[] | null;
  },
  now: number = Date.now(),
): PracticeSessionRow {
  const id = `psess_${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  db.prepare(
    `INSERT INTO practice_sessions (id, date, minutes, reviewed, notes, mode, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    dayString(now),
    Math.round(input.minutes ?? 0),
    input.reviewed ?? 0,
    input.notes ?? null,
    input.mode ?? null,
    input.detail && input.detail.length ? JSON.stringify(input.detail) : null,
    now,
  );
  return db.prepare(`SELECT * FROM practice_sessions WHERE id = ?`).get(id) as PracticeSessionRow;
}

export function parseRunDetail(raw: string | null): RunDetailEntry[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? (j as RunDetailEntry[]) : [];
  } catch {
    return [];
  }
}

export function recentSessions(db: Database.Database, limit = 30): PracticeSessionRow[] {
  return db
    .prepare(`SELECT * FROM practice_sessions ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as PracticeSessionRow[];
}

/** Consecutive-day streak of practice sessions, counting today or yesterday. */
export function streakDays(db: Database.Database, now: number = Date.now()): number {
  const dates = new Set(
    (db.prepare(`SELECT DISTINCT date FROM practice_sessions`).all() as { date: string }[]).map(
      (r) => r.date,
    ),
  );
  if (dates.size === 0) return 0;
  let streak = 0;
  // Start from today if practised today, else yesterday (grace for "not yet today").
  let cursor = dates.has(dayString(now)) ? now : now - DAY_MS;
  while (dates.has(dayString(cursor))) {
    streak += 1;
    cursor -= DAY_MS;
  }
  return streak;
}

export interface PracticeStats {
  total: number;
  byStatus: Record<PracticeStatus, number>;
  dueToday: number;
  newAvailable: number;
  streak: number;
  minutesThisWeek: number;
  reviewedThisWeek: number;
  todayMinutes: number;
  todayReviewed: number;
}

export function practiceStats(db: Database.Database, now: number = Date.now()): PracticeStats {
  const rows = db
    .prepare(`SELECT status, due_at FROM practice_items WHERE archived_at IS NULL`)
    .all() as { status: PracticeStatus; due_at: number | null }[];
  const byStatus: Record<PracticeStatus, number> = { new: 0, learning: 0, review: 0, mastered: 0 };
  const bound = endOfTodayMs(now);
  let dueToday = 0;
  let newAvailable = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === "new") newAvailable += 1;
    else if (r.due_at !== null && r.due_at <= bound) dueToday += 1;
  }
  const weekAgo = now - 7 * DAY_MS;
  const week = db
    .prepare(`SELECT minutes, reviewed, date, created_at FROM practice_sessions WHERE created_at >= ?`)
    .all(weekAgo) as { minutes: number; reviewed: number; date: string; created_at: number }[];
  const today = dayString(now);
  let minutesThisWeek = 0, reviewedThisWeek = 0, todayMinutes = 0, todayReviewed = 0;
  for (const s of week) {
    minutesThisWeek += s.minutes;
    reviewedThisWeek += s.reviewed;
    if (s.date === today) { todayMinutes += s.minutes; todayReviewed += s.reviewed; }
  }
  return {
    total: rows.length,
    byStatus,
    dueToday,
    newAvailable,
    streak: streakDays(db, now),
    minutesThisWeek,
    reviewedThisWeek,
    todayMinutes,
    todayReviewed,
  };
}

// ---------------------------------------------------------------------------
// Attempts — a log of every graded try, so Atlas remembers how you're doing
// and can surface where you need practice.
// ---------------------------------------------------------------------------

export interface PracticeAttemptRow {
  id: string;
  item_id: string;
  at: number;
  answer: string | null; // what the user submitted
  grade: string; // again | hard | good | easy
  score: number | null; // 0-100 (agent's estimate)
  feedback: string | null; // agent's evaluation (markdown)
  weak_tags: string | null; // JSON string[] — subskills that were weak
  seconds: number | null; // time spent on the attempt
  mode: string | null; // review | drill | coach | submit
}

export function insertAttempt(
  db: Database.Database,
  input: {
    itemId: string;
    answer?: string | null;
    grade: string;
    score?: number | null;
    feedback?: string | null;
    weakTags?: string[] | null;
    seconds?: number | null;
    mode?: string | null;
  },
  now: number = Date.now(),
): PracticeAttemptRow {
  const id = `att_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO practice_attempts (id, item_id, at, answer, grade, score, feedback, weak_tags, seconds, mode)
     VALUES (@id,@item_id,@at,@answer,@grade,@score,@feedback,@weak_tags,@seconds,@mode)`,
  ).run({
    id,
    item_id: input.itemId,
    at: now,
    answer: input.answer ?? null,
    grade: input.grade,
    score: input.score ?? null,
    feedback: input.feedback ?? null,
    weak_tags: input.weakTags && input.weakTags.length ? JSON.stringify(input.weakTags) : null,
    seconds: input.seconds ?? null,
    mode: input.mode ?? null,
  });
  return db.prepare(`SELECT * FROM practice_attempts WHERE id = ?`).get(id) as PracticeAttemptRow;
}

export function attemptsForItem(db: Database.Database, itemId: string, limit = 20): PracticeAttemptRow[] {
  return db
    .prepare(`SELECT * FROM practice_attempts WHERE item_id = ? ORDER BY at DESC LIMIT ?`)
    .all(itemId, limit) as PracticeAttemptRow[];
}

export interface WeakArea {
  area: string; // a tag or topic
  misses: number; // weighted miss count (again=2, hard=1)
  attempts: number;
  lastAt: number;
}

/** Aggregate where the user struggles, from graded attempts (recent window). */
export function weakAreas(db: Database.Database, sinceDays = 60, limit = 8): WeakArea[] {
  const since = Date.now() - sinceDays * 86_400_000;
  const rows = db
    .prepare(
      `SELECT a.grade, a.weak_tags, a.at, i.topic, i.tags AS item_tags
       FROM practice_attempts a JOIN practice_items i ON i.id = a.item_id
       WHERE a.at >= ?`,
    )
    .all(since) as { grade: string; weak_tags: string | null; at: number; topic: string | null; item_tags: string | null }[];
  const map = new Map<string, WeakArea>();
  const bump = (area: string, weight: number, at: number) => {
    const key = area.trim().toLowerCase();
    if (!key) return;
    const w = map.get(key) ?? { area: area.trim(), misses: 0, attempts: 0, lastAt: 0 };
    w.attempts += 1;
    w.misses += weight;
    w.lastAt = Math.max(w.lastAt, at);
    map.set(key, w);
  };
  for (const r of rows) {
    const weight = r.grade === "again" ? 2 : r.grade === "hard" ? 1 : 0;
    // Attribute misses to the agent's weak_tags, else the item's topic/tags.
    const tags = weak_tags_parse(r.weak_tags);
    const areas = tags.length ? tags : [r.topic ?? "", ...parseTags(r.item_tags)].filter(Boolean);
    for (const a of areas) bump(a, weight || 0.1, r.at); // tiny weight even when correct → tracks coverage
  }
  return [...map.values()].filter((w) => w.misses > 0.1).sort((a, b) => b.misses - a.misses).slice(0, limit);
}

function weak_tags_parse(raw: string | null): string[] {
  if (!raw) return [];
  try { const j = JSON.parse(raw); return Array.isArray(j) ? j.map(String) : []; } catch { return []; }
}

export function parseReviewLog(raw: string | null): ReviewLogEntry[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j)
      ? j.map((e: Record<string, unknown>) => ({
          at: Number(e.at ?? 0),
          grade: (e.grade as Grade) ?? "good",
          intervalDays: Number(e.intervalDays ?? 0),
        }))
      : [];
  } catch {
    return [];
  }
}

export { parseTags as parsePracticeTags };
