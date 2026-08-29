// Notes: a small standalone knowledge store for the Tracker plugin.
//
// Notes are their own entity (not tied to a task), but a note MAY reference a
// task. Notes carry tags and can [[link]] to each other by title — the basis
// for an Obsidian-style backlink + graph view. Pure functions over a
// better-sqlite3 handle so everything here is unit-testable; server.ts owns
// wiring (RPC, CLI, agent auto-tagging).
import type Database from "better-sqlite3";
import { normalizeTags, parseTags, serializeTags } from "./tasks";

export interface NoteRow {
  id: string;
  seq: number;
  title: string;
  body: string;
  tags: string | null; // JSON array
  project_id: string | null;
  task_id: string | null; // optional link to a task
  threads: string | null; // JSON array of bb thread ids (referenced chats)
  created_at: number;
  updated_at: number;
}

/** Parse the stored thread-ids JSON into a clean, deduped list. */
export function parseThreadIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of arr) {
      const s = String(v).trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeThreadIds(ids: string[]): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of ids) {
    const s = v.trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out.length ? JSON.stringify(out) : null;
}

/** Append-only. Runs AFTER the task migrations in one combined migrate call. */
export const NOTE_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS notes (
     id         TEXT PRIMARY KEY,
     seq        INTEGER NOT NULL UNIQUE,
     title      TEXT NOT NULL,
     body       TEXT NOT NULL DEFAULT '',
     tags       TEXT,
     project_id TEXT,
     task_id    TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes (updated_at)`,
  // v2: referenced bb threads (chats) as a JSON array of ids.
  `ALTER TABLE notes ADD COLUMN threads TEXT`,
];

function newId(): string {
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nextSeq(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM notes`)
    .get() as { next: number };
  return row.next;
}

// ---------------------------------------------------------------------------
// Wikilinks
// ---------------------------------------------------------------------------

/** Canonical key for matching a title to a [[wikilink]] target. */
export function titleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Extract raw [[target]] strings from a note body (pipe aliases stripped). */
export function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    // "[[Title|alias]]" → target is the part before the pipe.
    const target = m[1].split("|")[0]!.trim();
    if (target) out.push(target);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface NewNoteInput {
  title: string;
  body?: string | null;
  tags?: string[] | null;
  projectId?: string | null;
  taskId?: string | null;
  threadIds?: string[] | null;
}

export function insertNote(db: Database.Database, input: NewNoteInput): NoteRow {
  const id = newId();
  const seq = nextSeq(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO notes (id, seq, title, body, tags, project_id, task_id, threads, created_at, updated_at)
     VALUES (@id, @seq, @title, @body, @tags, @project_id, @task_id, @threads, @created_at, @updated_at)`,
  ).run({
    id,
    seq,
    title: input.title.trim(),
    body: input.body ?? "",
    tags: input.tags ? serializeTags(input.tags) : null,
    project_id: input.projectId ?? null,
    task_id: input.taskId ?? null,
    threads: input.threadIds ? serializeThreadIds(input.threadIds) : null,
    created_at: now,
    updated_at: now,
  });
  return getNoteById(db, id)!;
}

export function getNoteById(db: Database.Database, id: string): NoteRow | null {
  return (db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as NoteRow) ?? null;
}

/** Resolve a note by a user reference: bare number = seq, else id, else title. */
export function resolveNote(db: Database.Database, ref: string): NoteRow | null {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) {
    const bySeq = db
      .prepare(`SELECT * FROM notes WHERE seq = ?`)
      .get(Number(trimmed)) as NoteRow | undefined;
    if (bySeq) return bySeq;
  }
  const byId = getNoteById(db, trimmed);
  if (byId) return byId;
  const key = titleKey(trimmed);
  const all = db.prepare(`SELECT * FROM notes`).all() as NoteRow[];
  return all.find((n) => titleKey(n.title) === key) ?? null;
}

export interface NotePatch {
  title?: string;
  body?: string | null;
  tags?: string[] | null;
  projectId?: string | null;
  taskId?: string | null;
  threadIds?: string[] | null;
}

export function updateNote(
  db: Database.Database,
  id: string,
  patch: NotePatch,
): NoteRow | null {
  const existing = getNoteById(db, id);
  if (!existing) return null;
  const next = {
    title: patch.title !== undefined ? patch.title.trim() : existing.title,
    body: patch.body !== undefined ? (patch.body ?? "") : existing.body,
    tags:
      patch.tags !== undefined
        ? patch.tags
          ? serializeTags(patch.tags)
          : null
        : existing.tags,
    project_id:
      patch.projectId !== undefined ? patch.projectId : existing.project_id,
    task_id: patch.taskId !== undefined ? patch.taskId : existing.task_id,
    threads:
      patch.threadIds !== undefined
        ? patch.threadIds
          ? serializeThreadIds(patch.threadIds)
          : null
        : existing.threads,
    updated_at: Date.now(),
  };
  db.prepare(
    `UPDATE notes SET title=@title, body=@body, tags=@tags, project_id=@project_id,
       task_id=@task_id, threads=@threads, updated_at=@updated_at WHERE id=@id`,
  ).run({ ...next, id });
  return getNoteById(db, id);
}

export function deleteNote(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM notes WHERE id = ?`).run(id).changes > 0;
}

export interface NoteFilter {
  tag?: string | null;
  search?: string | null;
  projectId?: string | null;
}

export function queryNotes(db: Database.Database, filter: NoteFilter = {}): NoteRow[] {
  let rows = db
    .prepare(`SELECT * FROM notes ORDER BY updated_at DESC`)
    .all() as NoteRow[];
  if (filter.projectId) rows = rows.filter((r) => r.project_id === filter.projectId);
  if (filter.tag) {
    const t = filter.tag.toLowerCase();
    rows = rows.filter((r) => parseTags(r.tags).includes(t));
  }
  if (filter.search) {
    const q = filter.search.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q),
    );
  }
  return rows;
}

export function distinctNoteTags(db: Database.Database): string[] {
  const rows = db.prepare(`SELECT tags FROM notes`).all() as {
    tags: string | null;
  }[];
  const set = new Set<string>();
  for (const r of rows) for (const t of parseTags(r.tags)) set.add(t);
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Links + graph
// ---------------------------------------------------------------------------

/** Note ids whose body links (via [[title]]) to the given note. */
export function backlinks(notes: NoteRow[], noteId: string): NoteRow[] {
  const target = notes.find((n) => n.id === noteId);
  if (!target) return [];
  const key = titleKey(target.title);
  return notes.filter(
    (n) =>
      n.id !== noteId &&
      extractWikilinks(n.body).some((w) => titleKey(w) === key),
  );
}

export type GraphNodeKind = "note" | "task" | "tag" | "thread";
export type GraphEdgeKind = "link" | "tag" | "thread" | "ref";

export interface GraphNode {
  id: string; // "n:<id>" | "k:<id>" (task) | "t:<tag>" | "h:<threadId>"
  kind: GraphNodeKind;
  label: string;
  refId: string; // note/task/thread id, or tag name
  degree: number;
}
export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Minimal task shape the graph needs (avoids importing the full TaskRow). */
export interface GraphTask {
  id: string;
  title: string;
  status: "open" | "done";
  tags: string | null;
  notes: string | null;
  completion: string | null;
  task_id?: never;
}

/**
 * Unified activity graph across notes, tasks, tags, and referenced chats.
 * Notes and tasks both contribute nodes; [[wikilinks]] in either resolve to
 * notes OR tasks by title; tags and chats link everything together. This is
 * the "graph of all my activity" — the frontend filters by node kind.
 */
export function buildGraph(
  notes: NoteRow[],
  tasks: GraphTask[] = [],
  threadTitles: Map<string, string> = new Map(),
): Graph {
  // Title → node id, spanning notes and tasks, for wikilink resolution.
  const byKey = new Map<string, string>();
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const degree = new Map<string, number>();
  const seenEdge = new Set<string>();

  const add = (
    id: string,
    kind: GraphNodeKind,
    label: string,
    refId: string,
  ) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, label, refId, degree: 0 });
    return id;
  };
  const link = (from: string, to: string, kind: GraphEdgeKind) => {
    if (from === to) return;
    const key = `${from}|${to}|${kind}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ source: from, target: to, kind });
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  };
  const ensureTag = (tag: string) => add(`t:${tag}`, "tag", `#${tag}`, tag);
  const ensureThread = (tid: string) =>
    add(`h:${tid}`, "thread", threadTitles.get(tid) ?? `chat ${tid.slice(-4)}`, tid);

  // Register note + task nodes first so wikilinks can resolve to either.
  for (const n of notes) {
    const id = add(`n:${n.id}`, "note", n.title, n.id);
    byKey.set(titleKey(n.title), id);
  }
  for (const t of tasks) {
    const id = add(`k:${t.id}`, "task", t.title, t.id);
    if (!byKey.has(titleKey(t.title))) byKey.set(titleKey(t.title), id);
  }

  for (const n of notes) {
    const from = `n:${n.id}`;
    for (const w of extractWikilinks(n.body)) {
      const to = byKey.get(titleKey(w));
      if (to) link(from, to, "link");
    }
    for (const tag of normalizeTags(parseTags(n.tags))) link(from, ensureTag(tag), "tag");
    for (const tid of parseThreadIds(n.threads)) link(from, ensureThread(tid), "thread");
    if (n.task_id) link(from, add(`k:${n.task_id}`, "task", n.task_id, n.task_id), "ref");
  }

  for (const t of tasks) {
    const from = `k:${t.id}`;
    const text = `${t.title}\n${t.notes ?? ""}\n${t.completion ?? ""}`;
    for (const w of extractWikilinks(text)) {
      const to = byKey.get(titleKey(w));
      if (to) link(from, to, "link");
    }
    for (const tag of normalizeTags(parseTags(t.tags))) link(from, ensureTag(tag), "tag");
  }

  const out = [...nodes.values()].map((node) => ({
    ...node,
    degree: degree.get(node.id) ?? 0,
  }));
  return { nodes: out, edges };
}
