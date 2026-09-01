// bb-plugin-tracker — backend entry.
//
// A personal daily task tracker. One global list (with an optional project
// tag), auto-rollover of unfinished tasks, a `bb todo` CLI that any thread can
// drive, and RPC + realtime for the sidebar panel. Pure query/date logic lives
// in tasks.ts; this file is wiring.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  MIGRATIONS,
  closeTask,
  deleteTask,
  distinctTags,
  getTaskById,
  insertTask,
  linkTaskThread,
  unlinkTaskThread,
  threadIdsForTask,
  taskRowsForThread,
  logActivity,
  localParse,
  parseDueDate,
  parseTags,
  queryTasks,
  reorderTask,
  resolveTask,
  setArchived,
  setStage,
  setStatus,
  todayString,
  updateTask,
  localDateString,
  normalizeTags,
  type ParsedInput,
  type TaskRow,
  type TaskView,
  type Subtask,
  type Comment,
} from "./tasks";
import {
  NOTE_MIGRATIONS,
  backlinks,
  buildGraph,
  deleteNote,
  distinctNoteTags,
  extractWikilinks,
  getNoteById,
  insertNote,
  parseThreadIds,
  queryNotes,
  resolveNote,
  titleKey,
  updateNote,
  type NoteRow,
} from "./notes";
import {
  claimCaptures,
  deleteCapture as atlasDeleteCapture,
  fetchBlob,
  fetchBlobBytes,
  getCapture as atlasGetCapture,
  imagePrompt,
  listCaptures as atlasListCaptures,
  listFacets,
  parseEnrichment,
  patchCapture as atlasPatchCapture,
  patchEnrichment,
  textPrompt,
  type AtlasCapture,
  type AtlasConfig,
} from "./atlas";

const REALTIME_CHANNEL = "tracker";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const zTaskView = z.enum(["today", "upcoming", "all", "done", "archived"]);

const zTask = z.object({
  id: z.string(),
  seq: z.number().int(),
  title: z.string(),
  status: z.enum(["open", "done"]),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  notes: z.string().nullable(),
  dueDate: z.string().nullable(),
  createdAt: z.number(),
  doneAt: z.number().nullable(),
  carriedOver: z.boolean(),
  overdue: z.boolean(),
  tags: z.array(z.string()),
  link: z.string().nullable(),
  sortOrder: z.number().nullable(),
  completion: z.string().nullable(),
  urgent: z.boolean(),
  stage: z.enum(["planned", "doing", "hold", "done"]),
  links: z.array(z.string()),
  subtasks: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean() })),
  comments: z.array(z.object({ id: z.string(), text: z.string(), at: z.number() })),
  updatedAt: z.number(),
  activity: z.array(z.object({ at: z.number(), type: z.string() })),
  archivedAt: z.number().nullable(),
  threadIds: z.array(z.string()),
});

const zProject = z.object({ id: z.string(), name: z.string() });

const zNote = z.object({
  id: z.string(),
  seq: z.number().int(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  threads: z.array(z.object({ id: z.string(), title: z.string() })),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const zThreadRef = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.number(),
  projectId: z.string().nullable(),
});

const zNoteRef = z.object({
  id: z.string(),
  seq: z.number().int(),
  title: z.string(),
});

const zOutlink = z.object({
  target: z.string(),
  id: z.string().nullable(),
  seq: z.number().int().nullable(),
});

const zGraph = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["note", "task", "tag", "thread"]),
      label: z.string(),
      refId: z.string(),
      degree: z.number().int(),
    }),
  ),
  edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      kind: z.enum(["link", "tag", "thread", "ref"]),
    }),
  ),
});

const zCapture = z.object({
  id: z.string(),
  type: z.enum(["screenshot", "image", "highlight", "bookmark", "note"]),
  status: z.enum(["pending", "processing", "done", "failed"]),
  sourceUrl: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  selectionText: z.string().nullable(),
  noteText: z.string().nullable(),
  blobMime: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  hasBlob: z.boolean(),
  hasThumb: z.boolean(),
  ocrText: z.string().nullable(),
  description: z.string().nullable(),
  summary: z.string().nullable(),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  articleText: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  enrichedAt: z.number().nullable(),
});

const zFacet = z.object({ name: z.string(), count: z.number() });

export const rpcContract = defineRpcContract({
  listTasks: {
    input: z.object({
      view: zTaskView.default("today"),
      projectId: z.string().nullable().optional(),
      tag: z.string().nullable().optional(),
      search: z.string().nullable().optional(),
    }),
    output: z.object({
      today: z.string(),
      tasks: z.array(zTask),
      projects: z.array(zProject),
      allTags: z.array(z.string()),
    }),
  },
  addTask: {
    input: z.object({
      title: z.string().min(1),
      projectId: z.string().nullable().optional(),
      dueDate: z.string().regex(ISO_DATE).nullable().optional(),
      notes: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      link: z.string().nullable().optional(),
    }),
    output: z.object({ task: zTask }),
  },
  setStatus: {
    input: z.object({ id: z.string(), status: z.enum(["open", "done"]) }),
    output: z.object({ task: zTask }),
  },
  updateTask: {
    input: z.object({
      id: z.string(),
      title: z.string().min(1).optional(),
      notes: z.string().nullable().optional(),
      dueDate: z.string().regex(ISO_DATE).nullable().optional(),
      projectId: z.string().nullable().optional(),
      tags: z.array(z.string()).nullable().optional(),
      link: z.string().nullable().optional(),
      links: z.array(z.string()).nullable().optional(),
      subtasks: z
        .array(z.object({ id: z.string(), text: z.string(), done: z.boolean() }))
        .nullable()
        .optional(),
      comments: z
        .array(z.object({ id: z.string(), text: z.string(), at: z.number() }))
        .nullable()
        .optional(),
      completion: z.string().nullable().optional(),
      urgent: z.boolean().optional(),
    }),
    output: z.object({ task: zTask }),
  },
  close: {
    input: z.object({
      id: z.string(),
      summary: z.string().nullable().optional(),
      links: z.array(z.string()).optional(),
    }),
    output: z.object({ task: zTask }),
  },
  reorder: {
    input: z.object({
      id: z.string(),
      afterId: z.string().nullable().optional(),
      beforeId: z.string().nullable().optional(),
    }),
    output: z.object({ task: zTask }),
  },
  setStage: {
    input: z.object({ id: z.string(), stage: z.enum(["planned", "doing", "hold", "done"]) }),
    output: z.object({ task: zTask }),
  },
  archiveTask: {
    input: z.object({ id: z.string(), archived: z.boolean() }),
    output: z.object({ task: zTask }),
  },
  analyzeTask: {
    input: z.object({ id: z.string() }),
    output: z.object({
      task: zTask,
      analysis: z.string(),
      addedTags: z.array(z.string()),
      addedSubtasks: z.number(),
      usedAgent: z.boolean(),
    }),
  },
  // ----- task <-> thread links -----
  linkTaskThread: {
    input: z.object({ taskId: z.string(), threadId: z.string() }),
    output: z.object({ task: zTask }),
  },
  unlinkTaskThread: {
    input: z.object({ taskId: z.string(), threadId: z.string() }),
    output: z.object({ task: zTask }),
  },
  threadTasks: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ tasks: z.array(zTask) }),
  },
  taskThreadRefs: {
    input: z.object({ taskId: z.string() }),
    output: z.object({ threads: z.array(zThreadRef) }),
  },
  smartAdd: {
    input: z.object({
      text: z.string().min(1),
      projectId: z.string().nullable().optional(),
    }),
    output: z.object({
      task: zTask,
      parsed: z.object({
        title: z.string(),
        tags: z.array(z.string()),
        dueDate: z.string().nullable(),
        link: z.string().nullable(),
      }),
      usedAgent: z.boolean(),
    }),
  },
  deleteTask: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },

  // ----- notes -----
  listNotes: {
    input: z.object({
      tag: z.string().nullable().optional(),
      search: z.string().nullable().optional(),
      projectId: z.string().nullable().optional(),
    }),
    output: z.object({
      notes: z.array(zNote),
      allTags: z.array(z.string()),
      projects: z.array(zProject),
    }),
  },
  getNote: {
    input: z.object({ id: z.string() }),
    output: z.object({
      note: zNote,
      backlinks: z.array(zNoteRef),
      outlinks: z.array(zOutlink),
    }),
  },
  addNote: {
    input: z.object({
      title: z.string().min(1),
      body: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      projectId: z.string().nullable().optional(),
      taskId: z.string().nullable().optional(),
      threadIds: z.array(z.string()).optional(),
      autotag: z.boolean().optional(),
    }),
    output: z.object({ note: zNote }),
  },
  updateNote: {
    input: z.object({
      id: z.string(),
      title: z.string().min(1).optional(),
      body: z.string().nullable().optional(),
      tags: z.array(z.string()).nullable().optional(),
      projectId: z.string().nullable().optional(),
      taskId: z.string().nullable().optional(),
      threadIds: z.array(z.string()).nullable().optional(),
    }),
    output: z.object({ note: zNote }),
  },
  searchThreads: {
    input: z.object({
      query: z.string().nullable().optional(),
      limit: z.number().int().optional(),
    }),
    output: z.object({ threads: z.array(zThreadRef) }),
  },
  retagNote: {
    input: z.object({ id: z.string() }),
    output: z.object({ note: zNote, usedAgent: z.boolean() }),
  },
  deleteNote: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  getGraph: {
    input: z.object({ projectId: z.string().nullable().optional() }),
    output: zGraph,
  },
  // ----- Atlas captures (proxied to the omni backend) -----
  listCaptures: {
    input: z.object({
      type: z.string().nullable().optional(),
      status: z.string().nullable().optional(),
      tag: z.string().nullable().optional(),
      category: z.string().nullable().optional(),
      q: z.string().nullable().optional(),
      cursor: z.string().nullable().optional(),
      limit: z.number().int().optional(),
    }),
    output: z.object({
      captures: z.array(zCapture),
      nextCursor: z.string().nullable(),
      configured: z.boolean(),
    }),
  },
  getCapture: {
    input: z.object({ id: z.string() }),
    output: z.object({ capture: zCapture.nullable() }),
  },
  patchCapture: {
    input: z.object({
      id: z.string(),
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
      noteText: z.string().optional(),
      summary: z.string().optional(),
    }),
    output: z.object({ capture: zCapture.nullable() }),
  },
  deleteCapture: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  captureFacets: {
    input: z.object({}),
    output: z.object({
      tags: z.array(zFacet),
      categories: z.array(zFacet),
      configured: z.boolean(),
    }),
  },
});

type TaskDto = z.infer<typeof zTask>;

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  // Append-only by index across the WHOLE list: task migrations, then note
  // migrations, then any later additions at the very end. Never insert in the
  // middle — that shifts indices and re-runs already-applied statements.
  bb.storage.migrate(db, [
    ...MIGRATIONS,
    ...NOTE_MIGRATIONS,
    // v-late: urgent flag on tasks (floats to top + highlighted).
    `ALTER TABLE tasks ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0`,
    // v-late: kanban stage. Backfill so existing done tasks land in the Done column.
    `ALTER TABLE tasks ADD COLUMN stage TEXT`,
    `UPDATE tasks SET stage = CASE WHEN status = 'done' THEN 'done' ELSE 'planned' END WHERE stage IS NULL`,
    // v-late: multiple typed links per task (PRs, Slack threads, docs, URLs).
    `ALTER TABLE tasks ADD COLUMN links TEXT`,
    // v-late: subtask checklist ({ id, text, done }[]).
    `ALTER TABLE tasks ADD COLUMN subtasks TEXT`,
    // v-late: task comments / progress log ({ id, text, at }[]).
    `ALTER TABLE tasks ADD COLUMN comments TEXT`,
    // v-late: second-brain metadata — updated_at + a change log for time queries.
    `ALTER TABLE tasks ADD COLUMN updated_at INTEGER`,
    `UPDATE tasks SET updated_at = created_at WHERE updated_at IS NULL`,
    `ALTER TABLE tasks ADD COLUMN activity TEXT`,
    // v-late: archive (hide from the board, keep the data).
    `ALTER TABLE tasks ADD COLUMN archived_at INTEGER`,
    // v-late: many-to-many task <-> thread links (interaction linkage). A task
    // can be linked to several chats and a chat to several tasks.
    `CREATE TABLE IF NOT EXISTS task_threads (task_id TEXT NOT NULL, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (task_id, thread_id))`,
    `CREATE INDEX IF NOT EXISTS idx_task_threads_thread ON task_threads (thread_id)`,
    `CREATE INDEX IF NOT EXISTS idx_task_threads_task ON task_threads (task_id)`,
  ]);

  // ----- Atlas capture backend (self-hosted on omni) --------------------
  const settings = bb.settings.define({
    atlasBaseUrl: { type: "string", label: "Atlas backend URL", default: "" },
    atlasDeviceToken: {
      type: "string",
      label: "Atlas device token",
      secret: true,
    },
    atlasProjectId: {
      type: "string",
      label: "Project for enrichment threads (blank = personal)",
      default: "",
    },
    enrichEnabled: {
      type: "boolean",
      label: "Run capture enrichment",
      default: true,
    },
    enrichConcurrency: {
      type: "select",
      label: "Max concurrent enrich threads",
      options: ["1", "2", "3"],
      default: "2",
    },
  });

  /** Resolve the Atlas backend config, or null when not configured. */
  async function atlasConfig(): Promise<AtlasConfig | null> {
    const s = await settings.get();
    if (!s.atlasBaseUrl || !s.atlasDeviceToken) return null;
    return {
      baseUrl: s.atlasBaseUrl.replace(/\/+$/, ""),
      token: s.atlasDeviceToken,
    };
  }

  // ----- shared helpers -------------------------------------------------

  /** id -> display name for every project (personal included). */
  async function projectMap(): Promise<Map<string, string>> {
    try {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return new Map(projects.map((p) => [p.id, p.name] as const));
    } catch (err) {
      bb.log.warn(`could not list projects: ${String(err)}`);
      return new Map();
    }
  }

  function rowToDto(
    row: TaskRow,
    today: string,
    names: Map<string, string>,
  ): TaskDto {
    const overdue =
      row.status === "open" && row.due_date !== null && row.due_date < today;
    const carriedOver =
      row.status === "open" &&
      row.due_date === null &&
      localDateString(row.created_at) < today;
    return {
      id: row.id,
      seq: row.seq,
      title: row.title,
      status: row.status,
      projectId: row.project_id,
      projectName:
        row.project_id === null ? null : (names.get(row.project_id) ?? null),
      notes: row.notes,
      dueDate: row.due_date,
      createdAt: row.created_at,
      doneAt: row.done_at,
      carriedOver,
      overdue,
      tags: parseTags(row.tags),
      link: row.link,
      sortOrder: row.sort_order,
      completion: row.completion,
      urgent: row.urgent === 1,
      stage: (row.stage as "planned" | "doing" | "hold" | "done" | null) ??
        (row.status === "done" ? "done" : "planned"),
      links: (() => {
        let arr: string[] = [];
        if (row.links) {
          try {
            const j = JSON.parse(row.links);
            if (Array.isArray(j)) arr = j.map(String);
          } catch {
            /* ignore malformed */
          }
        }
        if (row.link && !arr.includes(row.link)) arr = [row.link, ...arr];
        return arr;
      })(),
      subtasks: (() => {
        if (!row.subtasks) return [];
        try {
          const j = JSON.parse(row.subtasks);
          return Array.isArray(j)
            ? j.map((s: { id?: unknown; text?: unknown; done?: unknown }) => ({
                id: String(s.id ?? ""),
                text: String(s.text ?? ""),
                done: !!s.done,
              }))
            : [];
        } catch {
          return [];
        }
      })(),
      comments: (() => {
        if (!row.comments) return [];
        try {
          const j = JSON.parse(row.comments);
          return Array.isArray(j)
            ? j.map((c: { id?: unknown; text?: unknown; at?: unknown }) => ({
                id: String(c.id ?? ""),
                text: String(c.text ?? ""),
                at: Number(c.at ?? 0),
              }))
            : [];
        } catch {
          return [];
        }
      })(),
      updatedAt: row.updated_at ?? row.created_at,
      activity: (() => {
        if (!row.activity) return [];
        try {
          const j = JSON.parse(row.activity);
          return Array.isArray(j)
            ? j.map((a: { at?: unknown; type?: unknown }) => ({ at: Number(a.at ?? 0), type: String(a.type ?? "") }))
            : [];
        } catch {
          return [];
        }
      })(),
      archivedAt: row.archived_at ?? null,
      threadIds: threadIdsForTask(db, row.id),
    };
  }

  /** Compose a completion write-up from a summary and any links (PRs, etc). */
  function formatCompletion(
    summary: string | null | undefined,
    links: string[] | undefined,
  ): string {
    const parts: string[] = [];
    if (summary && summary.trim()) parts.push(summary.trim());
    for (const l of links ?? []) {
      if (l && l.trim()) parts.push(l.trim());
    }
    return parts.join("\n");
  }

  /**
   * Agentic parse: ask a cheap model to turn a free-form message into task
   * fields. Falls back to the instant local parser if the model isn't
   * reachable or returns junk.
   */
  async function agentParse(
    text: string,
    projectId: string | null,
  ): Promise<{ parsed: ParsedInput; usedAgent: boolean }> {
    const local = localParse(text);
    const today = todayString();
    const prompt = `You convert a short note into a JSON todo. Today is ${today} (local).
Return ONLY minified JSON: {"title": string, "tags": string[], "dueDate": "YYYY-MM-DD"|null, "link": string|null}.
Rules: title is a concise imperative; tags are lowercase single words (no '#'); dueDate only if the note implies one; link only if a URL is present.
Note: ${JSON.stringify(text)}`;
    // The parse worker needs a project to run in; use the task's project or
    // fall back to the personal project. If neither resolves, stay local.
    const spawnProject =
      projectId ??
      (await bb.sdk.projects
        .list({ includePersonal: true })
        .catch(() => []))[0]?.id ??
      null;
    if (!spawnProject) return { parsed: local, usedAgent: false };

    let worker: { id: string } | null = null;
    try {
      worker = await bb.sdk.threads.spawn({
        projectId: spawnProject,
        environment: { type: "project-default" },
        prompt,
        visibility: "hidden",
        model: "claude-haiku-4-5-20251001",
      });
      await bb.sdk.threads.wait({ threadId: worker.id, status: "idle" });
      const out = await bb.sdk.threads.output({ threadId: worker.id });
      const jsonText = out.output ?? "";
      const m = jsonText.match(/\{[\s\S]*\}/);
      if (m) {
        const j = JSON.parse(m[0]) as Partial<ParsedInput>;
        return {
          usedAgent: true,
          parsed: {
            title: (typeof j.title === "string" && j.title.trim()) || local.title,
            tags: Array.isArray(j.tags) ? j.tags.map(String) : local.tags,
            dueDate:
              typeof j.dueDate === "string" && ISO_DATE.test(j.dueDate)
                ? j.dueDate
                : local.dueDate,
            link: typeof j.link === "string" ? j.link : local.link,
          },
        };
      }
    } catch (err) {
      bb.log.warn(`agentParse fell back to local: ${String(err)}`);
    } finally {
      if (worker) {
        await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
        await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => {});
      }
    }
    return { parsed: local, usedAgent: false };
  }

  /** Parse a row's stored subtasks/comments JSON (best-effort). */
  function rowSubtasks(row: TaskRow): Subtask[] {
    if (!row.subtasks) return [];
    try {
      const j = JSON.parse(row.subtasks);
      return Array.isArray(j)
        ? j.map((s: { id?: unknown; text?: unknown; done?: unknown }) => ({
            id: String(s.id ?? ""),
            text: String(s.text ?? ""),
            done: !!s.done,
          }))
        : [];
    } catch {
      return [];
    }
  }
  function rowComments(row: TaskRow): Comment[] {
    if (!row.comments) return [];
    try {
      const j = JSON.parse(row.comments);
      return Array.isArray(j)
        ? j.map((c: { id?: unknown; text?: unknown; at?: unknown }) => ({
            id: String(c.id ?? ""),
            text: String(c.text ?? ""),
            at: Number(c.at ?? 0),
          }))
        : [];
    } catch {
      return [];
    }
  }
  function shortId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Agentic analysis of an existing task: hand the whole task (title,
   * description, tags, links, subtasks, comments) to a cheap model and get back
   * a short assessment + suggested next-step subtasks + suggested tags. Mirrors
   * the agentParse spawn→wait→output→archive pattern; stays silent (returns an
   * empty result) if the model isn't reachable so the caller can no-op.
   */
  async function agentAnalyze(
    row: TaskRow,
    projectId: string | null,
  ): Promise<{ analysis: string; tags: string[]; subtasks: string[]; usedAgent: boolean }> {
    const subs = rowSubtasks(row);
    const comments = rowComments(row);
    const ctx: string[] = [];
    ctx.push(`Title: ${row.title}`);
    ctx.push(`Stage: ${row.stage ?? (row.status === "done" ? "done" : "planned")}`);
    if (row.due_date) ctx.push(`Due: ${row.due_date}`);
    const tags = parseTags(row.tags);
    if (tags.length) ctx.push(`Tags: ${tags.join(", ")}`);
    if (row.notes && row.notes.trim()) ctx.push(`Description: ${row.notes.trim()}`);
    const links = (() => {
      let arr: string[] = [];
      if (row.links) {
        try {
          const j = JSON.parse(row.links);
          if (Array.isArray(j)) arr = j.map(String);
        } catch { /* ignore */ }
      }
      if (row.link && !arr.includes(row.link)) arr = [row.link, ...arr];
      return arr;
    })();
    if (links.length) ctx.push(`Links:\n${links.map((l) => `- ${l}`).join("\n")}`);
    if (subs.length)
      ctx.push(
        `Subtasks:\n${subs.map((s) => `- [${s.done ? "x" : " "}] ${s.text}`).join("\n")}`,
      );
    if (comments.length)
      ctx.push(
        `Comments (oldest first):\n${comments
          .map((c) => `- ${localDateString(c.at)}: ${c.text}`)
          .join("\n")}`,
      );

    const prompt = `You are Atlas, a second-brain assistant. Analyze this task and help move it forward.
Return ONLY minified JSON: {"analysis": string, "tags": string[], "subtasks": string[]}.
- analysis: 2-4 plain-text sentences (no markdown). Assess where the task stands, surface any blocker or risk, and state the concrete next step. Take the comments and subtask progress into account.
- tags: 0-4 lowercase single-word tags worth ADDING that aren't already on the task; [] if none.
- subtasks: 0-5 short imperative next-step subtasks worth ADDING; [] if the task doesn't need any.
Task:
${ctx.join("\n")}`;

    const spawnProject =
      projectId ??
      (await bb.sdk.projects.list({ includePersonal: true }).catch(() => []))[0]?.id ??
      null;
    if (!spawnProject) return { analysis: "", tags: [], subtasks: [], usedAgent: false };

    let worker: { id: string } | null = null;
    try {
      worker = await bb.sdk.threads.spawn({
        projectId: spawnProject,
        environment: { type: "project-default" },
        prompt,
        visibility: "hidden",
        model: "claude-haiku-4-5-20251001",
      });
      await bb.sdk.threads.wait({ threadId: worker.id, status: "idle" });
      const out = await bb.sdk.threads.output({ threadId: worker.id });
      const m = (out.output ?? "").match(/\{[\s\S]*\}/);
      if (m) {
        const j = JSON.parse(m[0]) as {
          analysis?: unknown;
          tags?: unknown;
          subtasks?: unknown;
        };
        return {
          usedAgent: true,
          analysis: typeof j.analysis === "string" ? j.analysis.trim() : "",
          tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
          subtasks: Array.isArray(j.subtasks)
            ? j.subtasks.map(String).filter((s) => s.trim())
            : [],
        };
      }
    } catch (err) {
      bb.log.warn(`agentAnalyze failed: ${String(err)}`);
    } finally {
      if (worker) {
        await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
        await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => {});
      }
    }
    return { analysis: "", tags: [], subtasks: [], usedAgent: false };
  }

  function publishChanged() {
    bb.realtime.publish(REALTIME_CHANNEL, { at: Date.now() });
  }

  // ----- notes helpers --------------------------------------------------

  /** Resolve bb thread ids → titles (best-effort; missing/deleted → skipped). */
  async function resolveThreadTitles(
    ids: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        try {
          const t = await bb.sdk.threads.get({ threadId: id });
          out.set(id, t.title || t.titleFallback || `chat ${id.slice(-4)}`);
        } catch {
          /* thread gone / not visible — skip */
        }
      }),
    );
    return out;
  }

  function noteToDto(
    row: NoteRow,
    names: Map<string, string>,
    threadTitles: Map<string, string> = new Map(),
  ) {
    return {
      id: row.id,
      seq: row.seq,
      title: row.title,
      body: row.body,
      tags: parseTags(row.tags),
      projectId: row.project_id,
      projectName:
        row.project_id === null ? null : (names.get(row.project_id) ?? null),
      taskId: row.task_id,
      taskTitle: row.task_id
        ? (getTaskById(db, row.task_id)?.title ?? null)
        : null,
      threads: parseThreadIds(row.threads).map((id) => ({
        id,
        title: threadTitles.get(id) ?? `chat ${id.slice(-4)}`,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** All task rows (open + done) for the activity graph. */
  function allTaskRows(): TaskRow[] {
    return db.prepare(`SELECT * FROM tasks`).all() as TaskRow[];
  }

  /** YYYY-MM-DD -> ms epoch at the start (or end) of that local day. */
  function dayBoundMs(d: string | null | undefined, end: boolean): number | null {
    if (!d) return null;
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const dt = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0,
    );
    return dt.getTime();
  }

  interface SearchInput {
    query?: string | null;
    tags?: string[] | null;
    from?: string | null;
    to?: string | null;
    dateField?: "created" | "updated" | null;
    types?: ("task" | "note")[] | null;
    status?: "open" | "done" | "all" | null;
    projectId?: string | null;
    limit?: number | null;
  }

  /** The second-brain query: filter tasks + notes by text, tags, and a
   *  created/updated date window. Powers the tracker_search agent tool. */
  function searchItems(input: SearchInput): { tasks: TaskRow[]; notes: NoteRow[] } {
    const fromMs = dayBoundMs(input.from, false);
    const toMs = dayBoundMs(input.to, true);
    const dateField = input.dateField ?? "created";
    const q = (input.query ?? "").trim().toLowerCase();
    const wantTags = (input.tags ?? []).map((t) => t.replace(/^#/, "").toLowerCase());
    const types = input.types && input.types.length ? input.types : (["task", "note"] as const);

    const stamp = (created: number, updated: number | null | undefined) =>
      dateField === "updated" ? (updated ?? created) : created;
    const inRange = (created: number, updated: number | null | undefined) => {
      const v = stamp(created, updated);
      if (fromMs !== null && v < fromMs) return false;
      if (toMs !== null && v > toMs) return false;
      return true;
    };
    const hasTags = (tags: string[]) => wantTags.length === 0 || wantTags.some((t) => tags.includes(t));
    const matchText = (hay: string) => !q || hay.toLowerCase().includes(q);

    const tasks: TaskRow[] = [];
    if (types.includes("task")) {
      for (const r of allTaskRows()) {
        if (input.status && input.status !== "all" && r.status !== input.status) continue;
        if (input.projectId != null && r.project_id !== input.projectId) continue;
        if (!inRange(r.created_at, r.updated_at)) continue;
        const tags = parseTags(r.tags);
        if (!hasTags(tags)) continue;
        let commentText = "";
        try {
          commentText = r.comments
            ? (JSON.parse(r.comments) as { text?: string }[]).map((c) => c.text ?? "").join(" ")
            : "";
        } catch {
          /* ignore */
        }
        const hay = [r.title, r.notes, tags.join(" "), r.completion, commentText].filter(Boolean).join(" ");
        if (!matchText(hay)) continue;
        tasks.push(r);
      }
    }
    const notes: NoteRow[] = [];
    if (types.includes("note")) {
      for (const r of queryNotes(db)) {
        if (input.projectId != null && r.project_id !== input.projectId) continue;
        if (!inRange(r.created_at, r.updated_at)) continue;
        const tags = parseTags(r.tags);
        if (!hasTags(tags)) continue;
        const hay = [r.title, r.body, tags.join(" ")].filter(Boolean).join(" ");
        if (!matchText(hay)) continue;
        notes.push(r);
      }
    }
    const key = (created: number, updated: number | null | undefined) => stamp(created, updated);
    tasks.sort((a, b) => key(b.created_at, b.updated_at) - key(a.created_at, a.updated_at));
    notes.sort((a, b) => key(b.created_at, b.updated_at) - key(a.created_at, a.updated_at));
    const limit = input.limit ?? 50;
    return { tasks: tasks.slice(0, limit), notes: notes.slice(0, limit) };
  }

  /** Tags already written inline as #hashtags in the text. */
  function inlineHashtags(text: string): string[] {
    return normalizeTags(
      (text.match(/#([a-z0-9][a-z0-9-]*)/gi) ?? []).map((s) => s.slice(1)),
    );
  }

  /**
   * Ask a cheap model to derive topical tags for a note. Falls back to any
   * inline #hashtags if the model isn't reachable.
   */
  async function agentTagNote(
    title: string,
    body: string,
    projectId: string | null,
  ): Promise<{ tags: string[]; usedAgent: boolean }> {
    const local = inlineHashtags(`${title} ${body}`);
    const spawnProject =
      projectId ??
      (await bb.sdk.projects.list({ includePersonal: true }).catch(() => []))[0]
        ?.id ??
      null;
    if (!spawnProject) return { tags: local, usedAgent: false };

    const prompt = `You tag a personal knowledge note. Return ONLY minified JSON: {"tags": string[]}.
Give 2-5 lowercase, single-word topical tags (no '#', no spaces — use hyphens). Prefer reusable concepts over specifics.
Title: ${JSON.stringify(title)}
Body: ${JSON.stringify(body.slice(0, 2000))}`;

    let worker: { id: string } | null = null;
    try {
      worker = await bb.sdk.threads.spawn({
        projectId: spawnProject,
        environment: { type: "project-default" },
        prompt,
        visibility: "hidden",
        model: "claude-haiku-4-5-20251001",
      });
      await bb.sdk.threads.wait({ threadId: worker.id, status: "idle" });
      const out = await bb.sdk.threads.output({ threadId: worker.id });
      const m = (out.output ?? "").match(/\{[\s\S]*\}/);
      if (m) {
        const j = JSON.parse(m[0]) as { tags?: unknown };
        if (Array.isArray(j.tags)) {
          const tags = normalizeTags([...local, ...j.tags.map(String)]);
          return { tags, usedAgent: true };
        }
      }
    } catch (err) {
      bb.log.warn(`agentTagNote fell back to local: ${String(err)}`);
    } finally {
      if (worker) {
        await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
        await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => {});
      }
    }
    return { tags: local, usedAgent: false };
  }

  /** Resolve outgoing [[wikilinks]] of a note to (possibly missing) targets. */
  function noteOutlinks(row: NoteRow, all: NoteRow[]) {
    const byKey = new Map(all.map((n) => [titleKey(n.title), n] as const));
    const seen = new Set<string>();
    const out: { target: string; id: string | null; seq: number | null }[] = [];
    for (const w of extractWikilinks(row.body)) {
      const key = titleKey(w);
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = byKey.get(key);
      out.push({ target: w, id: hit?.id ?? null, seq: hit?.seq ?? null });
    }
    return out;
  }

  // ----- RPC (frontend data plane) -------------------------------------

  bb.rpc.register(rpcContract, {
    // ----- Atlas captures (proxy to the omni backend) -----
    async listCaptures(input) {
      const cfg = await atlasConfig();
      if (!cfg) return { captures: [], nextCursor: null, configured: false };
      try {
        const r = await atlasListCaptures(cfg, input);
        return { captures: r.captures, nextCursor: r.nextCursor, configured: true };
      } catch (err) {
        bb.log.warn(`atlas listCaptures: ${String(err)}`);
        return { captures: [], nextCursor: null, configured: true };
      }
    },
    async getCapture({ id }) {
      const cfg = await atlasConfig();
      return { capture: cfg ? await atlasGetCapture(cfg, id) : null };
    },
    async patchCapture({ id, ...patch }) {
      const cfg = await atlasConfig();
      return { capture: cfg ? await atlasPatchCapture(cfg, id, patch) : null };
    },
    async deleteCapture({ id }) {
      const cfg = await atlasConfig();
      return { ok: cfg ? await atlasDeleteCapture(cfg, id) : false };
    },
    async captureFacets() {
      const cfg = await atlasConfig();
      if (!cfg) return { tags: [], categories: [], configured: false };
      try {
        const f = await listFacets(cfg);
        return { ...f, configured: true };
      } catch (err) {
        bb.log.warn(`atlas captureFacets: ${String(err)}`);
        return { tags: [], categories: [], configured: true };
      }
    },
    async listTasks({ view, projectId, tag, search }) {
      const names = await projectMap();
      const today = todayString();
      const rows = queryTasks(db, view, projectId ?? undefined, {
        tag: tag ?? null,
        search: search ?? null,
      });
      return {
        today,
        tasks: rows.map((r) => rowToDto(r, today, names)),
        projects: [...names].map(([id, name]) => ({ id, name })),
        allTags: distinctTags(db),
      };
    },
    async addTask({ title, projectId, dueDate, notes, tags, link }) {
      const names = await projectMap();
      const row = insertTask(db, {
        title: title.trim(),
        projectId: projectId ?? null,
        dueDate: dueDate ?? null,
        notes: notes ?? null,
        tags: tags ?? null,
        link: link ?? null,
      });
      publishChanged();
      return { task: rowToDto(row, todayString(), names) };
    },
    async setStatus({ id, status }) {
      const row = setStatus(db, id, status);
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async updateTask({ id, title, notes, dueDate, projectId, tags, link, links, subtasks, comments, completion, urgent }) {
      const row = updateTask(db, id, { title, notes, dueDate, projectId, tags, link, links, subtasks, comments, completion, urgent });
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async close({ id, summary, links }) {
      const completion = formatCompletion(summary, links);
      const row = closeTask(db, id, completion || undefined);
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async reorder({ id, afterId, beforeId }) {
      const row = reorderTask(db, id, afterId ?? null, beforeId ?? null);
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async setStage({ id, stage }) {
      const row = setStage(db, id, stage);
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async archiveTask({ id, archived }) {
      const row = setArchived(db, id, archived);
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async analyzeTask({ id }) {
      const row = getTaskById(db, id);
      if (!row) throw new Error(`No task ${id}`);
      const res = await agentAnalyze(row, row.project_id);
      const now = Date.now();

      // Record the assessment as a timestamped, agent-marked comment.
      const analysis = res.analysis.trim();
      const comments = analysis
        ? [
            ...rowComments(row),
            { id: shortId("cm"), text: `🤖 ${analysis}`, at: now },
          ]
        : rowComments(row);

      // Merge suggested tags; append genuinely-new suggested subtasks.
      const tags = normalizeTags([...parseTags(row.tags), ...res.tags]);
      const existing = rowSubtasks(row);
      const have = new Set(existing.map((s) => s.text.trim().toLowerCase()));
      const added = res.subtasks
        .map((t) => t.trim())
        .filter((t) => t && !have.has(t.toLowerCase()));
      const subtasks: Subtask[] = [
        ...existing,
        ...added.map((t) => ({ id: shortId("st"), text: t, done: false })),
      ];

      updateTask(db, id, { comments, tags, subtasks });
      logActivity(db, id, "analyzed", now);
      publishChanged();
      const final = getTaskById(db, id)!;
      return {
        task: rowToDto(final, todayString(), await projectMap()),
        analysis,
        addedTags: res.tags,
        addedSubtasks: added.length,
        usedAgent: res.usedAgent,
      };
    },
    async linkTaskThread({ taskId, threadId }) {
      if (!getTaskById(db, taskId)) throw new Error(`No task ${taskId}`);
      linkTaskThread(db, taskId, threadId);
      logActivity(db, taskId, "linked-thread");
      publishChanged();
      return { task: rowToDto(getTaskById(db, taskId)!, todayString(), await projectMap()) };
    },
    async unlinkTaskThread({ taskId, threadId }) {
      if (!getTaskById(db, taskId)) throw new Error(`No task ${taskId}`);
      unlinkTaskThread(db, taskId, threadId);
      publishChanged();
      return { task: rowToDto(getTaskById(db, taskId)!, todayString(), await projectMap()) };
    },
    async threadTasks({ threadId }) {
      const names = await projectMap();
      const today = todayString();
      return { tasks: taskRowsForThread(db, threadId).map((r) => rowToDto(r, today, names)) };
    },
    async taskThreadRefs({ taskId }) {
      const ids = threadIdsForTask(db, taskId);
      const refs = await Promise.all(
        ids.map(async (id) => {
          try {
            const t = await bb.sdk.threads.get({ threadId: id });
            return {
              id,
              title: t.title || t.titleFallback || `chat ${id.slice(-4)}`,
              updatedAt: t.updatedAt ?? 0,
              projectId: t.projectId ?? null,
            };
          } catch {
            return null; // thread gone / not visible — drop it
          }
        }),
      );
      return { threads: refs.filter((r): r is NonNullable<typeof r> => r !== null) };
    },
    async smartAdd({ text, projectId }) {
      const { parsed, usedAgent } = await agentParse(text, projectId ?? null);
      const row = insertTask(db, {
        title: parsed.title.trim() || text.trim(),
        projectId: projectId ?? null,
        dueDate: parsed.dueDate,
        tags: parsed.tags,
        link: parsed.link,
      });
      publishChanged();
      return {
        task: rowToDto(row, todayString(), await projectMap()),
        parsed,
        usedAgent,
      };
    },
    async deleteTask({ id }) {
      const ok = deleteTask(db, id);
      if (ok) publishChanged();
      return { ok };
    },

    // ----- notes -----
    async listNotes({ tag, search, projectId }) {
      const names = await projectMap();
      const rows = queryNotes(db, {
        tag: tag ?? null,
        search: search ?? null,
        projectId: projectId ?? null,
      });
      const titles = await resolveThreadTitles(
        rows.flatMap((r) => parseThreadIds(r.threads)),
      );
      return {
        notes: rows.map((r) => noteToDto(r, names, titles)),
        allTags: distinctNoteTags(db),
        projects: [...names].map(([id, name]) => ({ id, name })),
      };
    },
    async getNote({ id }) {
      const row = getNoteById(db, id);
      if (!row) throw new Error(`No note ${id}`);
      const names = await projectMap();
      const all = queryNotes(db);
      const titles = await resolveThreadTitles(parseThreadIds(row.threads));
      return {
        note: noteToDto(row, names, titles),
        backlinks: backlinks(all, id).map((n) => ({
          id: n.id,
          seq: n.seq,
          title: n.title,
        })),
        outlinks: noteOutlinks(row, all),
      };
    },
    async searchThreads({ query, limit }) {
      let threads: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
      try {
        threads = await bb.sdk.threads.list({ limit: limit ?? 200 });
      } catch (err) {
        bb.log.warn(`searchThreads failed: ${String(err)}`);
      }
      const q = (query ?? "").trim().toLowerCase();
      const mapped = threads
        .map((t) => ({
          id: t.id,
          title: t.title || t.titleFallback || `chat ${t.id.slice(-4)}`,
          updatedAt: t.updatedAt,
          projectId: t.projectId ?? null,
        }))
        .filter((t) => !q || t.title.toLowerCase().includes(q))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit ?? 30);
      return { threads: mapped };
    },
    async addNote({ title, body, tags, projectId, taskId, threadIds, autotag }) {
      const names = await projectMap();
      const row = insertNote(db, {
        title: title.trim(),
        body: body ?? "",
        tags: tags && tags.length ? tags : null,
        projectId: projectId ?? null,
        taskId: taskId ?? null,
        threadIds: threadIds ?? null,
      });
      publishChanged();
      // Auto-tag in the background when the user didn't supply tags; the panel
      // refreshes over realtime once tags land.
      if (autotag !== false && (!tags || tags.length === 0)) {
        void (async () => {
          const { tags: auto } = await agentTagNote(
            row.title,
            row.body,
            projectId ?? null,
          );
          if (auto.length) {
            updateNote(db, row.id, { tags: auto });
            publishChanged();
          }
        })();
      }
      const titles = await resolveThreadTitles(threadIds ?? []);
      return { note: noteToDto(row, names, titles) };
    },
    async updateNote({ id, title, body, tags, projectId, taskId, threadIds }) {
      const row = updateNote(db, id, {
        title,
        body,
        tags: tags ?? undefined,
        projectId,
        taskId,
        threadIds: threadIds ?? undefined,
      });
      if (!row) throw new Error(`No note ${id}`);
      publishChanged();
      const titles = await resolveThreadTitles(parseThreadIds(row.threads));
      return { note: noteToDto(row, await projectMap(), titles) };
    },
    async retagNote({ id }) {
      const row = getNoteById(db, id);
      if (!row) throw new Error(`No note ${id}`);
      const { tags, usedAgent } = await agentTagNote(
        row.title,
        row.body,
        row.project_id,
      );
      const updated = updateNote(db, id, { tags });
      publishChanged();
      const titles = await resolveThreadTitles(parseThreadIds(updated!.threads));
      return {
        note: noteToDto(updated!, await projectMap(), titles),
        usedAgent,
      };
    },
    async deleteNote({ id }) {
      const ok = deleteNote(db, id);
      if (ok) publishChanged();
      return { ok };
    },
    async getGraph({ projectId }) {
      const noteRows = queryNotes(db, { projectId: projectId ?? null });
      const taskRows = allTaskRows().filter(
        (t) => !projectId || t.project_id === projectId,
      );
      const threadIds = noteRows.flatMap((r) => parseThreadIds(r.threads));
      const titles = await resolveThreadTitles(threadIds);
      return buildGraph(
        noteRows,
        taskRows.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          tags: t.tags,
          notes: t.notes,
          completion: t.completion,
        })),
        titles,
      );
    },
  });

  // ----- CLI (`bb todo …`) ---------------------------------------------

  bb.cli.register({
    name: "todo",
    summary: "Personal daily task tracker",
    commands: [
      { name: "add", summary: "Add a task", usage: 'bb todo add "<title>" [--project <id|.>] [--due <date>] [--tag a,b] [--link <url>] [--notes "<text>"]' },
      { name: "smart", summary: "Add a task from a free-form message (agentic)", usage: 'bb todo smart "<message>" [--project <id|.>]' },
      { name: "tag", summary: "Set tags on a task", usage: "bb todo tag <id> <tag> [tag…]" },
      { name: "urgent", summary: "Flag a task as urgent (highlighted + floated to top)", usage: "bb todo urgent <id> [--off]" },
      { name: "list", summary: "List tasks", usage: "bb todo list [--today|--upcoming|--all|--done] [--project <id|.>] [--tag <tag>] [--search <text>]" },
      { name: "done", summary: "Mark a task done", usage: "bb todo done <id>" },
      { name: "close", summary: "Complete a task and attach a summary / PR of what was done", usage: 'bb todo close <id> [--summary "<what was done>"] [--pr <url>] [--link <url>]' },
      { name: "undone", summary: "Reopen a task", usage: "bb todo undone <id>" },
      { name: "defer", summary: "Move a task to a later day", usage: "bb todo defer <id> --to <date>" },
      { name: "edit", summary: "Edit a task", usage: "bb todo edit <id> [--title \"<t>\"] [--due <date>] [--notes \"<n>\"] [--project <id|.>]" },
      { name: "rm", summary: "Delete a task", usage: "bb todo rm <id>" },
      { name: "note", summary: "Notes knowledge base (add/list/show/tag/rm)", usage: 'bb todo note add "<title>" [--body "<text>"] [--tag a,b] [--project <id|.>] [--task <id>]' },
    ],
    async run(argv, ctx) {
      const [sub, ...rest] = argv;
      const { positionals, flags } = parseArgs(rest);

      const resolveProjectFlag = (): string | null | undefined => {
        const v = flags.project;
        if (typeof v !== "string") return undefined;
        if (v === "." || v === "") return ctx.projectId ?? null;
        return v;
      };

      try {
        switch (sub) {
          case undefined:
          case "list": {
            const view: TaskView = flags.done
              ? "done"
              : flags.upcoming
                ? "upcoming"
                : flags.all
                  ? "all"
                  : "today";
            const proj = resolveProjectFlag();
            const names = await projectMap();
            const today = todayString();
            const rows = queryTasks(db, view, proj, {
              tag: typeof flags.tag === "string" ? flags.tag : null,
              search: typeof flags.search === "string" ? flags.search : null,
            });
            return { exitCode: 0, stdout: renderList(rows, view, today, names) };
          }

          case "add": {
            const rawTitle = positionals.join(" ").trim();
            if (!rawTitle) {
              return { exitCode: 1, stderr: 'Usage: bb todo add "<title>" [--project <id|.>] [--due <date>] [--tag a,b] [--link <url>] [--notes "<text>"]' };
            }
            // Parse inline #tags, URL, and date words; explicit flags win.
            const parsed = localParse(rawTitle);
            const proj = resolveProjectFlag();
            const dueDate =
              typeof flags.due === "string"
                ? parseDueDate(flags.due)
                : parsed.dueDate;
            const notes = typeof flags.notes === "string" ? flags.notes : null;
            const explicitTags =
              typeof flags.tag === "string"
                ? flags.tag.split(",").map((t) => t.trim())
                : [];
            const tags = [...explicitTags, ...parsed.tags];
            const link =
              typeof flags.link === "string" ? flags.link : parsed.link;
            const row = insertTask(db, {
              title: parsed.title,
              projectId: proj === undefined ? null : proj,
              dueDate,
              notes,
              tags: tags.length ? tags : null,
              link,
            });
            publishChanged();
            const names = await projectMap();
            return {
              exitCode: 0,
              stdout: `Added ${formatLine(row, todayString(), names)}`,
            };
          }

          case "smart": {
            const text = positionals.join(" ").trim();
            if (!text) {
              return { exitCode: 1, stderr: 'Usage: bb todo smart "<free-form message>" [--project <id|.>]' };
            }
            const proj = resolveProjectFlag();
            const { parsed, usedAgent } = await agentParse(
              text,
              proj === undefined ? null : proj,
            );
            const row = insertTask(db, {
              title: parsed.title.trim() || text,
              projectId: proj === undefined ? null : proj,
              dueDate: parsed.dueDate,
              tags: parsed.tags,
              link: parsed.link,
            });
            publishChanged();
            const names = await projectMap();
            return {
              exitCode: 0,
              stdout: `Added ${formatLine(row, todayString(), names)}${usedAgent ? " ✨" : ""}`,
            };
          }

          case "tag": {
            const row = requireTask(db, positionals[0]);
            const tags = positionals.slice(1).flatMap((t) => t.split(","));
            if (tags.length === 0) {
              return { exitCode: 1, stderr: "Usage: bb todo tag <id> <tag> [tag…]" };
            }
            const updated = updateTask(db, row.id, { tags });
            publishChanged();
            const names = await projectMap();
            return {
              exitCode: 0,
              stdout: `Tagged ${formatLine(updated!, todayString(), names)}`,
            };
          }

          case "urgent": {
            const row = requireTask(db, positionals[0]);
            const on = !flags.off;
            const updated = updateTask(db, row.id, { urgent: on });
            publishChanged();
            const names = await projectMap();
            return {
              exitCode: 0,
              stdout: `${on ? "⚡ Marked urgent" : "Cleared urgent"}: ${formatLine(updated!, todayString(), names)}`,
            };
          }

          case "done":
          case "undone": {
            const row = requireTask(db, positionals[0]);
            const updated = setStatus(db, row.id, sub === "done" ? "done" : "open");
            publishChanged();
            const names = await projectMap();
            return {
              exitCode: 0,
              stdout: `${sub === "done" ? "Done" : "Reopened"} ${formatLine(updated!, todayString(), names)}`,
            };
          }

          case "close": {
            const row = requireTask(db, positionals[0]);
            const summary =
              typeof flags.summary === "string"
                ? flags.summary
                : positionals.slice(1).join(" ") || null;
            const links = [
              typeof flags.pr === "string" ? `PR: ${flags.pr}` : "",
              typeof flags.link === "string" ? flags.link : "",
            ].filter(Boolean);
            const completion = formatCompletion(summary, links);
            const updated = closeTask(db, row.id, completion || undefined);
            publishChanged();
            const names = await projectMap();
            return {
              exitCode: 0,
              stdout: `Closed ${formatLine(updated!, todayString(), names)}${completion ? `\n  ↳ ${completion.replace(/\n/g, "\n  ↳ ")}` : ""}`,
            };
          }

          case "defer": {
            const row = requireTask(db, positionals[0]);
            const to = typeof flags.to === "string" ? flags.to : positionals[1];
            if (!to) {
              return { exitCode: 1, stderr: "Usage: bb todo defer <id> --to <date|tomorrow|+Nd>" };
            }
            const dueDate = parseDueDate(to);
            const updated = updateTask(db, row.id, { dueDate });
            publishChanged();
            const names = await projectMap();
            return {
              exitCode: 0,
              stdout: `Deferred to ${dueDate}: ${formatLine(updated!, todayString(), names)}`,
            };
          }

          case "edit": {
            const row = requireTask(db, positionals[0]);
            const patch: Parameters<typeof updateTask>[2] = {};
            if (typeof flags.title === "string") patch.title = flags.title;
            if (typeof flags.notes === "string") patch.notes = flags.notes;
            if (typeof flags.due === "string")
              patch.dueDate = parseDueDate(flags.due);
            const proj = resolveProjectFlag();
            if (proj !== undefined) patch.projectId = proj;
            if (Object.keys(patch).length === 0) {
              return { exitCode: 1, stderr: 'Nothing to change. Pass --title, --due, --notes, or --project.' };
            }
            const updated = updateTask(db, row.id, patch);
            publishChanged();
            const names = await projectMap();
            return {
              exitCode: 0,
              stdout: `Updated ${formatLine(updated!, todayString(), names)}`,
            };
          }

          case "rm":
          case "remove":
          case "delete": {
            const row = requireTask(db, positionals[0]);
            deleteTask(db, row.id);
            publishChanged();
            return { exitCode: 0, stdout: `Deleted #${row.seq}: ${row.title}` };
          }

          case "note": {
            const action = positionals[0];
            const names = await projectMap();
            const requireNote = (ref: string | undefined): NoteRow => {
              if (!ref) throw new Error("Which note? Pass its number, id, or title.");
              const n = resolveNote(db, ref);
              if (!n) throw new Error(`No note matching "${ref}".`);
              return n;
            };
            switch (action) {
              case undefined:
              case "list": {
                const rows = queryNotes(db, {
                  tag: typeof flags.tag === "string" ? flags.tag : null,
                  search: typeof flags.search === "string" ? flags.search : null,
                  projectId: resolveProjectFlag() ?? null,
                });
                return { exitCode: 0, stdout: renderNotes(rows) };
              }
              case "add": {
                const title = positionals.slice(1).join(" ").trim();
                if (!title) {
                  return { exitCode: 1, stderr: 'Usage: bb todo note add "<title>" [--body "<text>"] [--tag a,b] [--project <id|.>] [--task <id>]' };
                }
                const proj = resolveProjectFlag();
                const explicitTags =
                  typeof flags.tag === "string"
                    ? flags.tag.split(",").map((t) => t.trim())
                    : [];
                const taskRow =
                  typeof flags.task === "string" ? resolveTask(db, flags.task) : null;
                const row = insertNote(db, {
                  title,
                  body: typeof flags.body === "string" ? flags.body : "",
                  tags: explicitTags.length ? explicitTags : null,
                  projectId: proj === undefined ? null : proj,
                  taskId: taskRow?.id ?? null,
                });
                publishChanged();
                let tagNote = "";
                if (explicitTags.length === 0) {
                  const { tags, usedAgent } = await agentTagNote(
                    row.title,
                    row.body,
                    proj === undefined ? null : proj,
                  );
                  if (tags.length) {
                    updateNote(db, row.id, { tags });
                    publishChanged();
                    tagNote = ` [${tags.join(", ")}]${usedAgent ? " ✨" : ""}`;
                  }
                }
                return { exitCode: 0, stdout: `Saved note #${row.seq}: ${row.title}${tagNote}` };
              }
              case "show": {
                const row = requireNote(positionals[1]);
                const all = queryNotes(db);
                return { exitCode: 0, stdout: renderNoteDetail(row, all, names) };
              }
              case "tag": {
                const row = requireNote(positionals[1]);
                if (flags.auto) {
                  const { tags } = await agentTagNote(row.title, row.body, row.project_id);
                  updateNote(db, row.id, { tags });
                  publishChanged();
                  return { exitCode: 0, stdout: `Tagged #${row.seq}: [${tags.join(", ")}]` };
                }
                const tags = positionals.slice(2).flatMap((t) => t.split(","));
                if (!tags.length) return { exitCode: 1, stderr: "Usage: bb todo note tag <id> <tag…> | --auto" };
                updateNote(db, row.id, { tags });
                publishChanged();
                return { exitCode: 0, stdout: `Tagged #${row.seq}: [${normalizeTags(tags).join(", ")}]` };
              }
              case "rm":
              case "delete": {
                const row = requireNote(positionals[1]);
                deleteNote(db, row.id);
                publishChanged();
                return { exitCode: 0, stdout: `Deleted note #${row.seq}: ${row.title}` };
              }
              default:
                return { exitCode: 1, stderr: `Unknown note command "${action}". Try: add, list, show, tag, rm.` };
            }
          }

          case "help":
            return { exitCode: 0, stdout: HELP };

          default:
            return { exitCode: 1, stderr: `Unknown command "${sub}".\n\n${HELP}` };
        }
      } catch (err) {
        return { exitCode: 1, stderr: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  // ----- Native agent tool: close a task with a summary ----------------
  bb.agents.registerTool({
    name: "tracker_close_task",
    description:
      "Mark a task in the user's personal Tracker as done and attach a completion write-up (a summary of what was accomplished, PR/issue links, a session summary). Use when the user asks to close, complete, or finish a task in the tracker and record what was done.",
    instructions:
      "When the user asks to close/complete a Tracker task and attach a summary or PR, call tracker_close_task with a concise summary of what was accomplished and any related URLs.",
    presentation: {
      label: {
        pending: "Closing tracker task",
        completed: "Closed tracker task",
      },
    },
    parameters: z.object({
      task: z
        .string()
        .describe("Task reference: its number (e.g. 4), id, or a distinctive part of its title."),
      summary: z
        .string()
        .describe("A concise write-up of what was done for this task."),
      links: z
        .array(z.string())
        .optional()
        .describe("Related URLs — pull requests, issues, docs."),
    }),
    async execute({ task, summary, links }) {
      let row = resolveTask(db, task);
      if (!row) {
        const hits = db
          .prepare(
            `SELECT * FROM tasks WHERE status = 'open' AND title LIKE ? LIMIT 2`,
          )
          .all(`%${task}%`) as TaskRow[];
        if (hits.length === 1) row = hits[0];
      }
      if (!row) {
        return {
          content: [
            { type: "text", text: `No open Tracker task matching "${task}".` },
          ],
          isError: true,
        };
      }
      const completion = formatCompletion(summary, links);
      const updated = closeTask(db, row.id, completion || undefined);
      publishChanged();
      return `Closed "${updated!.title}" in the Tracker and attached the completion note.`;
    },
  });

  // ----- Native agent tool: add a note (agent supplies/derives tags) ----
  bb.agents.registerTool({
    name: "tracker_add_note",
    description:
      "Add a note to the user's personal Tracker knowledge base — standalone notes that carry tags and can [[link]] to other notes by title. Use when the user shares a thought, decision, reference, or snippet worth keeping. Give 2-5 lowercase topical tags so it's findable and links up in the graph.",
    instructions:
      "When the user shares something worth remembering (a decision, idea, reference, snippet), call tracker_add_note with a short title, the body, and 2-5 lowercase single-word topical tags. Use [[Note Title]] in the body to link related notes.",
    presentation: {
      label: {
        pending: "Saving note",
        completed: "Saved note",
      },
    },
    parameters: z.object({
      title: z.string().describe("A short, specific title for the note."),
      body: z
        .string()
        .optional()
        .describe(
          "The note content. May use [[Other Note Title]] to link to other notes.",
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe("2-5 lowercase single-word topical tags (no '#')."),
      task: z
        .string()
        .optional()
        .describe("Optional task reference (number/id/title) this note relates to."),
      projectId: z
        .string()
        .optional()
        .describe("Optional project id to file the note under."),
    }),
    async execute({ title, body, tags, task, projectId }, context) {
      const taskRow = task ? resolveTask(db, task) : null;
      // Auto-link the chat this note was created in, so it shows up in the graph.
      const threadIds = context.threadId ? [context.threadId] : null;
      const row = insertNote(db, {
        title: title.trim(),
        body: body ?? "",
        tags: tags && tags.length ? tags : null,
        projectId: projectId ?? null,
        taskId: taskRow?.id ?? null,
        threadIds,
      });
      publishChanged();
      if (!tags || tags.length === 0) {
        const { tags: auto } = await agentTagNote(
          row.title,
          row.body,
          projectId ?? null,
        );
        if (auto.length) {
          updateNote(db, row.id, { tags: auto });
          publishChanged();
        }
      }
      const final = getNoteById(db, row.id)!;
      const finalTags = parseTags(final.tags);
      return `Saved note #${final.seq} "${final.title}"${
        finalTags.length ? ` [${finalTags.join(", ")}]` : ""
      }.`;
    },
  });

  // ----- Native agent tool: search the second brain (tasks + notes) -----
  bb.agents.registerTool({
    name: "tracker_search",
    description:
      "Search the user's Atlas second brain — their personal tasks and notes — by free text, tags, and a created/updated date range. Use this to answer questions like 'what promotion tasks did I add in August', 'notes I edited last week', or 'open tasks tagged design'. Dates are YYYY-MM-DD; pick dateField 'created' (default, = when it was added) or 'updated' (= last edited).",
    instructions:
      "When the user asks to find or recall their own tasks/notes by topic and/or time (e.g. 'what did I add in August about X'), translate it into tracker_search: put the topic in `query`, the month/period into `from`/`to` (YYYY-MM-DD), and choose dateField 'created' for 'added' or 'updated' for 'edited/touched'.",
    presentation: { label: { pending: "Searching Atlas", completed: "Searched Atlas" } },
    parameters: z.object({
      query: z.string().optional().describe("free text to match in title, notes/body, tags, and comments"),
      tags: z.array(z.string()).optional().describe("only items carrying any of these tags"),
      from: z.string().regex(ISO_DATE).optional().describe("start date YYYY-MM-DD (inclusive)"),
      to: z.string().regex(ISO_DATE).optional().describe("end date YYYY-MM-DD (inclusive)"),
      dateField: z.enum(["created", "updated"]).optional().describe("'created' = when added (default); 'updated' = last edited"),
      types: z.array(z.enum(["task", "note"])).optional().describe("restrict to tasks and/or notes"),
      status: z.enum(["open", "done", "all"]).optional().describe("task status filter"),
      limit: z.number().int().optional(),
    }),
    async execute({ query, tags, from, to, dateField, types, status, limit }) {
      const { tasks, notes } = searchItems({ query, tags, from, to, dateField, types, status, limit });
      const names = await projectMap();
      const d = (ms: number) => localDateString(ms);
      const span = from || to ? ` in ${dateField ?? "created"} range ${from ?? "…"}–${to ?? "…"}` : "";
      const lines: string[] = [
        `Found ${tasks.length} task(s) and ${notes.length} note(s)${query ? ` matching "${query}"` : ""}${span}.`,
      ];
      if (tasks.length) {
        lines.push("", "Tasks:");
        for (const t of tasks) {
          const tg = parseTags(t.tags);
          const upd = t.updated_at && t.updated_at !== t.created_at ? ` · updated ${d(t.updated_at)}` : "";
          lines.push(
            `- #${t.seq} ${t.title} · ${t.status}/${t.stage ?? "planned"} · created ${d(t.created_at)}${upd}` +
              `${tg.length ? ` · [${tg.join(", ")}]` : ""}${t.project_id ? ` · ${names.get(t.project_id) ?? ""}` : ""}`,
          );
        }
      }
      if (notes.length) {
        lines.push("", "Notes:");
        for (const n of notes) {
          const tg = parseTags(n.tags);
          const upd = n.updated_at && n.updated_at !== n.created_at ? ` · updated ${d(n.updated_at)}` : "";
          lines.push(`- #${n.seq} ${n.title} · created ${d(n.created_at)}${upd}${tg.length ? ` · [${tg.join(", ")}]` : ""}`);
        }
      }
      if (!tasks.length && !notes.length) lines.push("No matches — try a wider date range or fewer filters.");
      return lines.join("\n");
    },
  });

  // ----- Native agent tool: link a task to this chat --------------------
  bb.agents.registerTool({
    name: "tracker_link_task",
    description:
      "Link a task in the user's Atlas Tracker to a bb chat thread, so the task shows up in that thread's info panel and the thread shows up on the task. Many chats can link to one task and one chat to many tasks. Use when the user says 'link this to task 4', 'attach this chat to the login task', or wants to connect the current conversation to a task. Defaults to the current thread when no thread is given.",
    instructions:
      "When the user wants to connect the current chat to a Tracker task (e.g. 'link this thread to task 12'), call tracker_link_task with the task reference. Omit threadId to link the current thread. Set unlink:true to remove a link.",
    presentation: {
      label: { pending: "Linking task", completed: "Linked task" },
    },
    parameters: z.object({
      task: z
        .string()
        .describe("Task reference: its number (e.g. 4), id, or a distinctive part of its title."),
      threadId: z
        .string()
        .optional()
        .describe("Thread to link; defaults to the current chat."),
      unlink: z
        .boolean()
        .optional()
        .describe("Remove the link instead of adding it."),
    }),
    async execute({ task, threadId, unlink }, context) {
      const tid = threadId ?? context.threadId ?? null;
      if (!tid) {
        return {
          content: [{ type: "text", text: "No thread to link — run this from inside a chat or pass threadId." }],
          isError: true,
        };
      }
      let row = resolveTask(db, task);
      if (!row) {
        const hits = db
          .prepare(`SELECT * FROM tasks WHERE title LIKE ? LIMIT 2`)
          .all(`%${task}%`) as TaskRow[];
        if (hits.length === 1) row = hits[0];
      }
      if (!row) {
        return {
          content: [{ type: "text", text: `No Tracker task matching "${task}".` }],
          isError: true,
        };
      }
      if (unlink) {
        unlinkTaskThread(db, row.id, tid);
        publishChanged();
        return `Unlinked this chat from task #${row.seq} "${row.title}".`;
      }
      linkTaskThread(db, row.id, tid);
      logActivity(db, row.id, "linked-thread");
      publishChanged();
      return `Linked this chat to task #${row.seq} "${row.title}". It now shows in the thread's info panel and on the task in Atlas.`;
    },
  });

  // ----- Atlas enrichment worker ----------------------------------------

  const atlasSleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

  /** Project the hidden enrichment threads (and their attachments) run in. */
  async function resolveEnrichProject(): Promise<string | null> {
    const s = await settings.get();
    if (s.atlasProjectId) return s.atlasProjectId;
    const projects = await bb.sdk.projects
      .list({ includePersonal: true })
      .catch(() => []);
    return projects[0]?.id ?? null;
  }

  const MAX_VISION_BYTES = 10 * 1024 * 1024;

  /** Enrich one capture by spawning a hidden agent thread (reuses the
   *  agentTagNote spawn→wait→output→archive pattern, extended to vision). */
  async function enrichOne(cfg: AtlasConfig, cap: AtlasCapture): Promise<void> {
    const projectId = await resolveEnrichProject();
    if (!projectId) throw new Error("no project to run enrichment in");

    let worker: { id: string } | null = null;
    try {
      const isVisual =
        (cap.type === "screenshot" || cap.type === "image") && cap.hasBlob;
      if (isVisual) {
        const { bytes, mime } = await fetchBlobBytes(cfg, cap.id);
        if (bytes.length <= MAX_VISION_BYTES) {
          const ext = (mime.split("/")[1] || "png").split("+")[0];
          const uploaded = await bb.sdk.projects.attachments.upload({
            projectId,
            clientFile: bytes,
            filename: `capture.${ext}`,
            mimeType: mime,
          });
          worker = await bb.sdk.threads.spawn({
            projectId,
            environment: { type: "project-default" },
            input: [
              { type: "text", text: imagePrompt(cap), mentions: [] },
              uploaded.type === "localFile"
                ? { type: "localFile", path: uploaded.path, mimeType: mime }
                : { type: "localImage", path: uploaded.path },
            ],
            visibility: "hidden",
            model: "claude-haiku-4-5-20251001",
          });
        }
      }
      // Text path (highlights/notes/bookmarks, or an oversized screenshot).
      if (!worker) {
        worker = await bb.sdk.threads.spawn({
          projectId,
          environment: { type: "project-default" },
          prompt: textPrompt(cap),
          visibility: "hidden",
          model: "claude-haiku-4-5-20251001",
        });
      }

      await bb.sdk.threads.wait({ threadId: worker.id, status: "idle" });
      const out = await bb.sdk.threads.output({ threadId: worker.id });
      const enrichment = parseEnrichment(out.output ?? "");
      if (!enrichment) throw new Error("could not parse enrichment JSON");
      await patchEnrichment(cfg, cap.id, {
        ...enrichment,
        model: "claude-haiku-4-5-20251001",
        status: "done",
      });
    } catch (err) {
      bb.log.warn(`atlas enrichOne ${cap.id}: ${String(err)}`);
      await patchEnrichment(cfg, cap.id, {
        status: "failed",
        error: String(err).slice(0, 500),
      }).catch(() => {});
    } finally {
      if (worker) {
        await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
        await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => {});
      }
    }
  }

  async function runPool<T>(
    items: T[],
    size: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    const queue = [...items];
    const runners = Array.from(
      { length: Math.min(size, queue.length) },
      async () => {
        while (queue.length) await fn(queue.shift()!);
      },
    );
    await Promise.all(runners);
  }

  bb.background.service("atlas-enrich", {
    async start(signal) {
      bb.log.info("atlas-enrich worker started");
      while (!signal.aborted) {
        try {
          const s = await settings.get();
          const cfg = await atlasConfig();
          if (!s.enrichEnabled || !cfg) {
            await atlasSleep(10_000, signal);
            continue;
          }
          const concurrency = Number(s.enrichConcurrency) || 2;
          const claimed = await claimCaptures(
            cfg,
            `bb-${bb.pluginId}`,
            concurrency,
          );
          if (!claimed.length) {
            await atlasSleep(8_000, signal);
            continue;
          }
          await runPool(claimed, concurrency, (c) => enrichOne(cfg, c));
          publishChanged();
        } catch (err) {
          bb.log.warn(`atlas-enrich loop: ${String(err)}`);
          await atlasSleep(10_000, signal);
        }
      }
    },
  });

  // Proxy blob/thumb from the backend using the server-side token so the
  // frontend <img> never sees it. Exact-match routes → id via ?id= query.
  function copyBlobHeaders(up: Response): Record<string, string> {
    const h: Record<string, string> = {};
    for (const k of [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
      "cache-control",
    ]) {
      const v = up.headers.get(k);
      if (v) h[k] = v;
    }
    return h;
  }
  const blobProxy =
    (which: "blob" | "thumb") =>
    async (c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }) => {
      const id = c.req.query("id");
      const cfg = await atlasConfig();
      if (!id || !cfg) return new Response("not found", { status: 404 });
      const up = await fetchBlob(cfg, id, which, c.req.header("range"));
      return new Response(up.body, {
        status: up.status,
        headers: copyBlobHeaders(up),
      });
    };
  bb.http.route("GET", "/capture-blob", blobProxy("blob"), { auth: "local" });
  bb.http.route("GET", "/capture-thumb", blobProxy("thumb"), { auth: "local" });

  bb.onDispose(() => {
    bb.log.info("tracker disposed");
  });
}

// ---------------------------------------------------------------------------
// CLI helpers (pure)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that consume the following token as their value. */
const VALUE_FLAGS = new Set([
  "project",
  "due",
  "notes",
  "to",
  "title",
  "tag",
  "link",
  "search",
  "summary",
  "pr",
  "body",
  "task",
]);

function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      const name = t.slice(2);
      if (VALUE_FLAGS.has(name)) {
        flags[name] = tokens[++i] ?? "";
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(t);
    }
  }
  return { positionals, flags };
}

function requireTask(db: Database.Database, ref: string | undefined): TaskRow {
  if (!ref) throw new Error("Which task? Pass its id, e.g. `bb todo done 4`.");
  const row = resolveTask(db, ref);
  if (!row) throw new Error(`No task matching "${ref}".`);
  return row;
}

function formatLine(
  row: TaskRow,
  today: string,
  names: Map<string, string>,
): string {
  const box = row.status === "done" ? "[x]" : "[ ]";
  const parts = [`#${row.seq}`, box, row.title];
  const meta: string[] = [];
  if (row.due_date) {
    if (row.status === "open" && row.due_date < today) {
      meta.push(`overdue ${row.due_date}`);
    } else if (row.due_date !== today) {
      meta.push(`due ${row.due_date}`);
    }
  } else if (row.status === "open" && localDateString(row.created_at) < today) {
    meta.push("carried over");
  }
  if (row.project_id) {
    meta.push(names.get(row.project_id) ?? row.project_id);
  }
  if (meta.length) parts.push(`(${meta.join(" · ")})`);
  return parts.join("  ");
}

const VIEW_TITLES: Record<TaskView, string> = {
  today: "Today",
  upcoming: "Upcoming",
  all: "All open tasks",
  done: "Completed",
  archived: "Archived",
};

function renderList(
  rows: TaskRow[],
  view: TaskView,
  today: string,
  names: Map<string, string>,
): string {
  const header = `${VIEW_TITLES[view]} — ${today}`;
  if (rows.length === 0) {
    const empty =
      view === "done"
        ? "Nothing completed yet."
        : view === "upcoming"
          ? "Nothing scheduled ahead."
          : "All clear. Add one with `bb todo add \"…\"`.";
    return `${header}\n${empty}`;
  }
  const lines = rows.map((r) => `  ${formatLine(r, today, names)}`);
  const open = rows.filter((r) => r.status === "open").length;
  const footer =
    view === "done"
      ? `${rows.length} completed`
      : `${open} open${rows.length - open ? `, ${rows.length - open} done today` : ""}`;
  return `${header}\n${lines.join("\n")}\n\n${footer}`;
}

function renderNotes(rows: NoteRow[]): string {
  if (rows.length === 0) {
    return 'No notes yet. Add one with `bb todo note add "…"`.';
  }
  const lines = rows.map((r) => {
    const tags = parseTags(r.tags);
    const tagStr = tags.length ? `  [${tags.join(", ")}]` : "";
    return `  #${r.seq}  ${r.title}${tagStr}`;
  });
  return `Notes (${rows.length})\n${lines.join("\n")}`;
}

function renderNoteDetail(
  row: NoteRow,
  all: NoteRow[],
  _names: Map<string, string>,
): string {
  const tags = parseTags(row.tags);
  const byKey = new Map(all.map((n) => [titleKey(n.title), n] as const));
  const outlinks = extractWikilinks(row.body).map((w) => {
    const hit = byKey.get(titleKey(w));
    return hit ? `#${hit.seq} ${hit.title}` : `${w} (missing)`;
  });
  const key = titleKey(row.title);
  const back = all
    .filter(
      (n) =>
        n.id !== row.id &&
        extractWikilinks(n.body).some((w) => titleKey(w) === key),
    )
    .map((n) => `#${n.seq} ${n.title}`);
  const parts = [`#${row.seq}  ${row.title}`];
  if (tags.length) parts.push(`tags: ${tags.join(", ")}`);
  if (row.body.trim()) parts.push("", row.body.trim());
  if (outlinks.length) parts.push("", `links → ${outlinks.join(", ")}`);
  if (back.length) parts.push(`linked from ← ${back.join(", ")}`);
  return parts.join("\n");
}

const HELP = `bb todo — personal daily task tracker

  bb todo add "<title>" [--project <id|.>] [--due <date>] [--notes "<text>"]
  bb todo list [--today|--upcoming|--all|--done] [--project <id|.>]
  bb todo done <id>          mark a task complete
  bb todo undone <id>        reopen a completed task
  bb todo defer <id> --to <date>   move it to a later day
  bb todo edit <id> [--title|--due|--notes|--project ...]
  bb todo rm <id>            delete a task

<id> is the short number shown in the list (e.g. 4).
<date> accepts YYYY-MM-DD, today, tomorrow, or +Nd (e.g. +3d).
--project . tags the task with the current thread's project.
Unfinished tasks roll over and keep showing under "today" until done.`;
