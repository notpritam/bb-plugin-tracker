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
  addTaskComment,
  appendTaskNotes,
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
  INITIATIVE_STATUSES,
  addInitiativeUpdate,
  deleteInitiative,
  getInitiativeById,
  initiativeRowsForThread,
  insertInitiative,
  linkInitiativeThread,
  listInitiatives,
  logInitiativeActivity,
  parseInitiativeActivity,
  parseInitiativeLinks,
  parseInitiativeTags,
  parsePhases,
  parseUpdates,
  resolveInitiative,
  setInitiativePhases,
  setInitiativeArchived,
  setInitiativeStatus,
  setTaskInitiative,
  tasksForInitiative,
  threadIdsForInitiative,
  unlinkInitiativeThread,
  updateInitiative,
  type InitiativeRow,
  type InitiativeStatus,
  type InitiativePhase,
} from "./initiatives";
import {
  PRACTICE_KINDS,
  deletePracticeItem,
  distinctTopics,
  dueItems,
  attemptsForItem,
  getPracticeItemById,
  insertAttempt,
  insertPracticeItem,
  itemsForNote,
  weakAreas,
  listPracticeItems,
  logSession,
  parsePracticeTags,
  parseReviewLog,
  parseRunDetail,
  practiceStats,
  recentSessions,
  resolvePracticeItem,
  reviewPracticeItem,
  setPracticeArchived,
  updatePracticeItem,
  type Grade,
  type PracticeItemRow,
  type PracticeSessionRow,
  type PracticeAttemptRow,
} from "./practice";
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
  initiativeId: z.string().nullable(),
});

const zProject = z.object({ id: z.string(), name: z.string() });

const zInitiativeStatus = z.enum(["idea", "active", "paused", "shipped"]);
const zPhaseStatus = z.enum(["pending", "active", "done"]);
const zInitiativePhase = z.object({
  id: z.string(),
  name: z.string(),
  status: zPhaseStatus,
});
const zInitiativeUpdate = z.object({
  id: z.string(),
  text: z.string(),
  at: z.number(),
  status: zInitiativeStatus.nullable().optional(),
  phaseId: z.string().nullable().optional(),
});
const zInitiative = z.object({
  id: z.string(),
  seq: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  status: zInitiativeStatus,
  color: z.string().nullable(),
  tags: z.array(z.string()),
  links: z.array(z.string()),
  updates: z.array(zInitiativeUpdate),
  phases: z.array(zInitiativePhase),
  createdAt: z.number(),
  updatedAt: z.number(),
  activity: z.array(z.object({ at: z.number(), type: z.string() })),
  archivedAt: z.number().nullable(),
  threadIds: z.array(z.string()),
  taskCount: z.number(),
  doneCount: z.number(),
});

const zPracticeKind = z.enum(["concept", "coding", "system-design", "frontend", "flashcard", "other"]);
const zPracticeStatus = z.enum(["new", "learning", "review", "mastered"]);
const zGrade = z.enum(["again", "hard", "good", "easy"]);
const zPracticeItem = z.object({
  id: z.string(),
  seq: z.number().int(),
  title: z.string(),
  topic: z.string().nullable(),
  kind: z.string(),
  question: z.string().nullable(),
  solution: z.string().nullable(),
  difficulty: z.string().nullable(),
  source: z.string().nullable(),
  noteId: z.string().nullable(),
  noteTitle: z.string().nullable(),
  tags: z.array(z.string()),
  status: zPracticeStatus,
  dueAt: z.number().nullable(),
  intervalDays: z.number(),
  ease: z.number(),
  reps: z.number(),
  lapses: z.number(),
  lastReviewedAt: z.number().nullable(),
  reviewLog: z.array(z.object({ at: z.number(), grade: z.string(), intervalDays: z.number() })),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
});
const zPracticeStats = z.object({
  total: z.number(),
  byStatus: z.object({ new: z.number(), learning: z.number(), review: z.number(), mastered: z.number() }),
  dueToday: z.number(),
  newAvailable: z.number(),
  streak: z.number(),
  minutesThisWeek: z.number(),
  reviewedThisWeek: z.number(),
  todayMinutes: z.number(),
  todayReviewed: z.number(),
});
const zRunDetail = z.object({
  itemId: z.string(),
  title: z.string().optional(),
  kind: z.string().optional(),
  topic: z.string().optional(),
  grade: z.string().optional(),
  seconds: z.number().optional(),
});
const zPracticeSession = z.object({
  id: z.string(),
  date: z.string(),
  minutes: z.number(),
  reviewed: z.number(),
  notes: z.string().nullable(),
  mode: z.string().nullable(),
  detail: z.array(zRunDetail),
  createdAt: z.number(),
});
const zAttempt = z.object({
  id: z.string(),
  itemId: z.string(),
  at: z.number(),
  answer: z.string().nullable(),
  grade: z.string(),
  score: z.number().nullable(),
  feedback: z.string().nullable(),
  weakTags: z.array(z.string()),
  seconds: z.number().nullable(),
  mode: z.string().nullable(),
});
const zWeakArea = z.object({ area: z.string(), misses: z.number(), attempts: z.number(), lastAt: z.number() });

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
  askAgentAboutTask: {
    input: z.object({ taskId: z.string(), message: z.string().min(1) }),
    output: z.object({ threadId: z.string() }),
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
  // ----- initiatives -----
  listInitiatives: {
    input: z.object({
      status: zInitiativeStatus.nullable().optional(),
      archived: z.boolean().optional(),
    }),
    output: z.object({ initiatives: z.array(zInitiative) }),
  },
  getInitiative: {
    input: z.object({ id: z.string() }),
    output: z.object({
      initiative: zInitiative,
      tasks: z.array(zTask),
      threads: z.array(zThreadRef),
    }),
  },
  addInitiative: {
    input: z.object({
      title: z.string().min(1),
      description: z.string().nullable().optional(),
      status: zInitiativeStatus.optional(),
      tags: z.array(z.string()).optional(),
      links: z.array(z.string()).optional(),
    }),
    output: z.object({ initiative: zInitiative }),
  },
  updateInitiative: {
    input: z.object({
      id: z.string(),
      title: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      status: zInitiativeStatus.optional(),
      tags: z.array(z.string()).nullable().optional(),
      links: z.array(z.string()).nullable().optional(),
      color: z.string().nullable().optional(),
    }),
    output: z.object({ initiative: zInitiative }),
  },
  setInitiativeStatus: {
    input: z.object({ id: z.string(), status: zInitiativeStatus }),
    output: z.object({ initiative: zInitiative }),
  },
  addInitiativeUpdate: {
    input: z.object({
      id: z.string(),
      text: z.string().min(1),
      status: zInitiativeStatus.nullable().optional(),
      phaseId: z.string().nullable().optional(),
    }),
    output: z.object({ initiative: zInitiative }),
  },
  setInitiativePhases: {
    input: z.object({
      id: z.string(),
      phases: z.array(zInitiativePhase),
    }),
    output: z.object({ initiative: zInitiative }),
  },
  archiveInitiative: {
    input: z.object({ id: z.string(), archived: z.boolean() }),
    output: z.object({ initiative: zInitiative }),
  },
  deleteInitiative: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  setTaskInitiative: {
    input: z.object({ taskId: z.string(), initiativeId: z.string().nullable() }),
    output: z.object({ task: zTask }),
  },
  linkInitiativeThread: {
    input: z.object({ initiativeId: z.string(), threadId: z.string() }),
    output: z.object({ initiative: zInitiative }),
  },
  unlinkInitiativeThread: {
    input: z.object({ initiativeId: z.string(), threadId: z.string() }),
    output: z.object({ initiative: zInitiative }),
  },
  initiativeThreadRefs: {
    input: z.object({ id: z.string() }),
    output: z.object({ threads: z.array(zThreadRef) }),
  },
  threadInitiatives: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ initiatives: z.array(zInitiative) }),
  },
  // ----- practice (spaced-repetition learning) -----
  listPractice: {
    input: z.object({
      topic: z.string().nullable().optional(),
      kind: z.string().nullable().optional(),
      status: zPracticeStatus.nullable().optional(),
      tag: z.string().nullable().optional(),
      search: z.string().nullable().optional(),
      archived: z.boolean().optional(),
    }),
    output: z.object({
      items: z.array(zPracticeItem),
      topics: z.array(z.string()),
      stats: zPracticeStats,
    }),
  },
  getPractice: {
    input: z.object({ id: z.string() }),
    output: z.object({ item: zPracticeItem }),
  },
  addPractice: {
    input: z.object({
      title: z.string().min(1),
      topic: z.string().nullable().optional(),
      kind: zPracticeKind.optional(),
      question: z.string().nullable().optional(),
      solution: z.string().nullable().optional(),
      difficulty: z.string().nullable().optional(),
      source: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      dueNow: z.boolean().optional(),
    }),
    output: z.object({ item: zPracticeItem }),
  },
  smartAddPractice: {
    input: z.object({ text: z.string().min(1), dueNow: z.boolean().optional() }),
    output: z.object({ item: zPracticeItem, usedAgent: z.boolean() }),
  },
  updatePractice: {
    input: z.object({
      id: z.string(),
      title: z.string().min(1).optional(),
      topic: z.string().nullable().optional(),
      kind: zPracticeKind.optional(),
      question: z.string().nullable().optional(),
      solution: z.string().nullable().optional(),
      difficulty: z.string().nullable().optional(),
      source: z.string().nullable().optional(),
      noteId: z.string().nullable().optional(),
      tags: z.array(z.string()).nullable().optional(),
      dueAt: z.number().nullable().optional(),
      status: zPracticeStatus.optional(),
    }),
    output: z.object({ item: zPracticeItem }),
  },
  reviewPractice: {
    input: z.object({ id: z.string(), grade: zGrade }),
    output: z.object({ item: zPracticeItem }),
  },
  archivePractice: {
    input: z.object({ id: z.string(), archived: z.boolean() }),
    output: z.object({ item: zPracticeItem }),
  },
  deletePractice: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  practiceQueue: {
    input: z.object({ newLimit: z.number().int().optional() }),
    output: z.object({ due: z.array(zPracticeItem), fresh: z.array(zPracticeItem) }),
  },
  logPracticeSession: {
    input: z.object({
      minutes: z.number().optional(),
      reviewed: z.number().optional(),
      notes: z.string().nullable().optional(),
      mode: z.string().nullable().optional(),
      detail: z.array(zRunDetail).nullable().optional(),
    }),
    output: z.object({ session: zPracticeSession, stats: zPracticeStats }),
  },
  practiceSessions: {
    input: z.object({ limit: z.number().int().optional() }),
    output: z.object({ sessions: z.array(zPracticeSession) }),
  },
  practiceFromNote: {
    input: z.object({
      noteId: z.string(),
      count: z.number().int().optional(),
      dueNow: z.boolean().optional(),
    }),
    output: z.object({ count: z.number(), items: z.array(zPracticeItem) }),
  },
  practiceForNote: {
    input: z.object({ noteId: z.string() }),
    output: z.object({ items: z.array(zPracticeItem) }),
  },
  startPracticeCoach: {
    input: z.object({
      itemId: z.string(),
      persona: z.enum(["teacher", "interviewer", "peer", "drill"]).optional(),
      level: z.enum(["junior", "mid", "senior", "staff"]).optional(),
      focus: z.string().nullable().optional(),
    }),
    output: z.object({ threadId: z.string() }),
  },
  evaluatePracticeAttempt: {
    input: z.object({
      itemId: z.string(),
      answer: z.string(),
      seconds: z.number().optional(),
      mode: z.string().optional(),
      level: z.enum(["junior", "mid", "senior", "staff"]).optional(),
    }),
    output: z.object({
      evaluated: z.boolean(),
      grade: z.string(),
      score: z.number().nullable(),
      feedback: z.string(),
      weakTags: z.array(z.string()),
      correct: z.boolean(),
      item: zPracticeItem,
    }),
  },
  practiceAttempts: {
    input: z.object({ itemId: z.string(), limit: z.number().int().optional() }),
    output: z.object({ attempts: z.array(zAttempt) }),
  },
  practiceWeakAreas: {
    input: z.object({ sinceDays: z.number().int().optional() }),
    output: z.object({ areas: z.array(zWeakArea) }),
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
    // v-late: initiatives — a project/idea/effort that groups tasks, carries a
    // lifecycle state, a timeline of updates, links and linked chats.
    `CREATE TABLE IF NOT EXISTS initiatives (
       id TEXT PRIMARY KEY,
       seq INTEGER NOT NULL,
       title TEXT NOT NULL,
       description TEXT,
       status TEXT NOT NULL DEFAULT 'idea',
       color TEXT,
       tags TEXT,
       links TEXT,
       updates TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       activity TEXT,
       archived_at INTEGER
     )`,
    `CREATE TABLE IF NOT EXISTS initiative_threads (initiative_id TEXT NOT NULL, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (initiative_id, thread_id))`,
    `CREATE INDEX IF NOT EXISTS idx_initiative_threads_thread ON initiative_threads (thread_id)`,
    `CREATE INDEX IF NOT EXISTS idx_initiative_threads_initiative ON initiative_threads (initiative_id)`,
    // A task can belong to one initiative.
    `ALTER TABLE tasks ADD COLUMN initiative_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_initiative ON tasks (initiative_id)`,
    // v-late: initiative roadmap phases ({ id, name, status }[]).
    `ALTER TABLE initiatives ADD COLUMN phases TEXT`,
    // v-late: Practice — spaced-repetition learning items + daily sessions.
    `CREATE TABLE IF NOT EXISTS practice_items (
       id TEXT PRIMARY KEY,
       seq INTEGER NOT NULL,
       title TEXT NOT NULL,
       topic TEXT,
       kind TEXT NOT NULL DEFAULT 'concept',
       question TEXT,
       solution TEXT,
       difficulty TEXT,
       source TEXT,
       tags TEXT,
       status TEXT NOT NULL DEFAULT 'new',
       due_at INTEGER,
       interval_days REAL NOT NULL DEFAULT 0,
       ease REAL NOT NULL DEFAULT 2.5,
       reps INTEGER NOT NULL DEFAULT 0,
       lapses INTEGER NOT NULL DEFAULT 0,
       last_reviewed_at INTEGER,
       review_log TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       archived_at INTEGER
     )`,
    `CREATE INDEX IF NOT EXISTS idx_practice_due ON practice_items (archived_at, status, due_at)`,
    `CREATE TABLE IF NOT EXISTS practice_sessions (
       id TEXT PRIMARY KEY,
       date TEXT NOT NULL,
       minutes INTEGER NOT NULL DEFAULT 0,
       reviewed INTEGER NOT NULL DEFAULT 0,
       notes TEXT,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_practice_sessions_date ON practice_sessions (date)`,
    // v-late: practice items can be generated from / linked to a note.
    `ALTER TABLE practice_items ADD COLUMN note_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_practice_note ON practice_items (note_id)`,
    // v-late: save practice runs in depth (mode + per-item detail) for self-learning.
    `ALTER TABLE practice_sessions ADD COLUMN mode TEXT`,
    `ALTER TABLE practice_sessions ADD COLUMN detail TEXT`,
    // v-late: attempts — a log of every graded try (submit → teacher evaluates),
    // so Atlas remembers progress and surfaces weak areas.
    `CREATE TABLE IF NOT EXISTS practice_attempts (
       id TEXT PRIMARY KEY,
       item_id TEXT NOT NULL,
       at INTEGER NOT NULL,
       answer TEXT,
       grade TEXT NOT NULL,
       score INTEGER,
       feedback TEXT,
       weak_tags TEXT,
       seconds INTEGER,
       mode TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_practice_attempts_item ON practice_attempts (item_id)`,
    `CREATE INDEX IF NOT EXISTS idx_practice_attempts_at ON practice_attempts (at)`,
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
    harvestOnDone: {
      type: "boolean",
      label: "On task completion, harvest a knowledge-base note (agentic)",
      default: true,
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
      initiativeId: row.initiative_id ?? null,
    };
  }

  // ----- initiatives DTO ------------------------------------------------
  function initiativeToDto(row: InitiativeRow) {
    return {
      id: row.id,
      seq: row.seq,
      title: row.title,
      description: row.description,
      status: row.status,
      color: row.color,
      tags: parseInitiativeTags(row.tags),
      links: parseInitiativeLinks(row.links),
      updates: parseUpdates(row.updates),
      phases: parsePhases(row.phases),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activity: parseInitiativeActivity(row.activity),
      archivedAt: row.archived_at ?? null,
      threadIds: threadIdsForInitiative(db, row.id),
      taskCount: (db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE initiative_id = ? AND archived_at IS NULL`,
        )
        .get(row.id) as { n: number }).n,
      doneCount: (db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE initiative_id = ? AND archived_at IS NULL AND status = 'done'`,
        )
        .get(row.id) as { n: number }).n,
    };
  }

  // ----- practice DTO ---------------------------------------------------
  function practiceToDto(row: PracticeItemRow) {
    return {
      id: row.id,
      seq: row.seq,
      title: row.title,
      topic: row.topic,
      kind: row.kind,
      question: row.question,
      solution: row.solution,
      difficulty: row.difficulty,
      source: row.source,
      noteId: row.note_id ?? null,
      noteTitle: row.note_id ? (getNoteById(db, row.note_id)?.title ?? null) : null,
      tags: parsePracticeTags(row.tags),
      status: row.status,
      dueAt: row.due_at ?? null,
      intervalDays: row.interval_days,
      ease: row.ease,
      reps: row.reps,
      lapses: row.lapses,
      lastReviewedAt: row.last_reviewed_at ?? null,
      reviewLog: parseReviewLog(row.review_log),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at ?? null,
    };
  }
  function sessionToDto(s: PracticeSessionRow) {
    return {
      id: s.id, date: s.date, minutes: s.minutes, reviewed: s.reviewed, notes: s.notes,
      mode: s.mode ?? null, detail: parseRunDetail(s.detail), createdAt: s.created_at,
    };
  }
  function attemptToDto(a: PracticeAttemptRow) {
    let weakTags: string[] = [];
    if (a.weak_tags) { try { const j = JSON.parse(a.weak_tags); if (Array.isArray(j)) weakTags = j.map(String); } catch { /* ignore */ } }
    return {
      id: a.id, itemId: a.item_id, at: a.at, answer: a.answer, grade: a.grade,
      score: a.score ?? null, feedback: a.feedback, weakTags, seconds: a.seconds ?? null, mode: a.mode ?? null,
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

  /** A readable multi-line dump of a task — its notes, comments, links, etc. */
  function formatTaskDetail(row: TaskRow, names: Map<string, string>): string {
    const d = (ms: number) => new Date(ms).toLocaleString();
    const tags = parseTags(row.tags);
    const subs = rowSubtasks(row);
    const comments = rowComments(row);
    let linkArr: string[] = [];
    if (row.links) {
      try { const j = JSON.parse(row.links); if (Array.isArray(j)) linkArr = j.map(String); } catch { /* ignore */ }
    }
    if (row.link && !linkArr.includes(row.link)) linkArr = [row.link, ...linkArr];
    const initiative = row.initiative_id ? getInitiativeById(db, row.initiative_id) : null;
    const lines: string[] = [
      `#${row.seq}  ${row.title}   [${row.status}/${row.stage ?? "planned"}]${row.urgent ? "  ⚡ urgent" : ""}${row.archived_at ? "  (archived)" : ""}`,
    ];
    const meta: string[] = [];
    if (row.due_date) meta.push(`due ${row.due_date}`);
    if (row.project_id) meta.push(`project ${names.get(row.project_id) ?? row.project_id}`);
    if (initiative) meta.push(`initiative #${initiative.seq} ${initiative.title}`);
    if (tags.length) meta.push(`tags: ${tags.join(", ")}`);
    if (meta.length) lines.push(meta.join("  ·  "));
    lines.push(`created ${d(row.created_at)}${row.updated_at && row.updated_at !== row.created_at ? ` · updated ${d(row.updated_at)}` : ""}`);
    if (row.notes && row.notes.trim()) lines.push("", "Notes:", row.notes.trim());
    if (subs.length) lines.push("", "Subtasks:", ...subs.map((s) => `  [${s.done ? "x" : " "}] ${s.text}`));
    if (linkArr.length) lines.push("", "Links:", ...linkArr.map((l) => `  - ${l}`));
    if (comments.length) lines.push("", "Comments:", ...comments.map((c) => `  · ${d(c.at)}: ${c.text}`));
    const threads = threadIdsForTask(db, row.id);
    if (threads.length) lines.push("", `Linked chats: ${threads.length}`);
    return lines.join("\n");
  }

  /** A readable dump of an initiative — phases, tasks, updates, links. */
  function formatInitiativeDetail(row: InitiativeRow): string {
    const d = (ms: number) => new Date(ms).toLocaleString();
    const phs = parsePhases(row.phases);
    const ups = parseUpdates(row.updates);
    const tks = tasksForInitiative(db, row.id);
    const links = parseInitiativeLinks(row.links);
    const tags = parseInitiativeTags(row.tags);
    const lines: string[] = [
      `#${row.seq}  ${row.title}   [${row.status}]${row.archived_at ? "  (archived)" : ""}`,
    ];
    if (tags.length) lines.push(`tags: ${tags.join(", ")}`);
    lines.push(`created ${d(row.created_at)}${row.updated_at !== row.created_at ? ` · updated ${d(row.updated_at)}` : ""}`);
    if (row.description && row.description.trim()) lines.push("", row.description.trim());
    if (phs.length) lines.push("", "Phases:", ...phs.map((p) => `  ${p.status === "done" ? "✓" : p.status === "active" ? "▶" : "○"} ${p.name}`));
    if (tks.length) lines.push("", "Tasks:", ...tks.map((t) => `  #${t.seq} [${t.status}/${t.stage ?? "planned"}] ${t.title}`));
    if (links.length) lines.push("", "Links:", ...links.map((l) => `  - ${l}`));
    if (ups.length) {
      lines.push("", "Updates:");
      for (const u of ups) {
        const ph = u.phaseId ? phs.find((p) => p.id === u.phaseId)?.name : null;
        lines.push(`  · ${d(u.at)}${ph ? ` [${ph}]` : ""}: ${u.text}`);
      }
    }
    const threads = threadIdsForInitiative(db, row.id);
    if (threads.length) lines.push("", `Linked chats: ${threads.length}`);
    return lines.join("\n");
  }

  /**
   * Post-completion knowledge harvest: hand a completed task to a cheap model
   * and turn it into a knowledge-base note (what was done, decisions, learnings,
   * links), linked to the task and its chats so it joins the second-brain graph.
   * Mirrors the agentParse spawn→wait→output→archive pattern. `force` runs it
   * regardless of the harvestOnDone setting (for the manual tool).
   */
  async function harvestTaskToKb(
    taskId: string,
    opts: { extraNote?: string | null; force?: boolean } = {},
  ): Promise<{ noteSeq: number; noteTitle: string } | null> {
    const s = await settings.get();
    if (!opts.force && !s.harvestOnDone) return null;
    const row = getTaskById(db, taskId);
    if (!row) return null;

    const ctx = formatTaskDetail(row, await projectMap());
    const extra =
      opts.extraNote && opts.extraNote.trim()
        ? `\n\nCompletion note from the user (process this too):\n${opts.extraNote.trim()}`
        : "";
    const prompt = `You are Atlas, the user's second brain. A task was just completed. Capture what's worth remembering as a knowledge-base note.
Return ONLY minified JSON: {"title": string, "body": string, "tags": string[]}.
- title: a short, specific note title (not merely the task title).
- body: markdown — 2-6 sentences or bullets covering what was accomplished, key decisions/learnings/gotchas, and any follow-ups. Include relevant links from the task.
- tags: 2-5 lowercase single-word tags.
Completed task:
${ctx}${extra}`;

    const spawnProject =
      s.atlasProjectId ||
      (await bb.sdk.projects.list({ includePersonal: true }).catch(() => []))[0]?.id ||
      row.project_id ||
      null;
    if (!spawnProject) return null;

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
      if (!m) return null;
      const j = JSON.parse(m[0]) as { title?: unknown; body?: unknown; tags?: unknown };
      const title = (typeof j.title === "string" && j.title.trim()) || `Done: ${row.title}`;
      const body = typeof j.body === "string" ? j.body : "";
      const tags = Array.isArray(j.tags) ? j.tags.map(String) : [];
      const note = insertNote(db, {
        title,
        body,
        tags: tags.length ? tags : null,
        projectId: row.project_id,
        taskId: row.id,
        threadIds: threadIdsForTask(db, row.id),
      });
      addTaskComment(db, row.id, `📚 Harvested to knowledge base → note #${note.seq} "${note.title}"`);
      logActivity(db, row.id, "harvested");
      publishChanged();
      return { noteSeq: note.seq, noteTitle: note.title };
    } catch (err) {
      bb.log.warn(`harvestTaskToKb failed: ${String(err)}`);
      return null;
    } finally {
      if (worker) {
        await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
        await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => {});
      }
    }
  }

  /** Fire the harvest when a task transitions from not-done → done. */
  function maybeHarvest(
    prevStatus: "open" | "done",
    rowAfter: TaskRow | undefined,
    extraNote?: string | null,
  ): void {
    if (!rowAfter || prevStatus === "done" || rowAfter.status !== "done") return;
    void harvestTaskToKb(rowAfter.id, { extraNote });
  }

  /**
   * Turn a note (a blog, an article, reading material) into spaced-repetition
   * practice: a hidden agent reads the note body and writes N Q&A items, each
   * linked back to the note so Practice "maintains" the material.
   */
  async function generatePracticeFromNote(
    noteId: string,
    count: number,
    dueNow: boolean,
  ): Promise<PracticeItemRow[]> {
    const note = getNoteById(db, noteId);
    if (!note) return [];
    const s = await settings.get();
    const body = (note.body ?? "").slice(0, 12000);
    const n = Math.max(1, Math.min(20, count));
    const prompt = `You are Atlas, the user's study assistant. From the reading below, write ${n} spaced-repetition practice questions that test real understanding (mix recall and application — not trivia).
Return ONLY minified JSON: an array of {"title": string, "question": string, "solution": string, "kind": "concept"|"coding"|"system-design"|"frontend"|"flashcard"|"other", "difficulty": "easy"|"medium"|"hard", "tags": string[]}.
- question: a COMPLETE, self-contained markdown prompt — state the exact task, any constraints/assumptions, and (where relevant) input/output format or a concrete example, plus what a strong answer should cover. It must be answerable without seeing the reading and without guessing. No vague one-liners.
- solution: a correct, detailed markdown answer grounded in the reading — the reasoning/approach and key points, not just a label. For coding, include a worked solution; for system design, cover requirements/API/data/scale/tradeoffs.
- title: short and specific.
Reading — "${note.title}":
${body || "(the note has no body — infer sensible questions from the title)"}`;
    const spawnProject =
      s.atlasProjectId ||
      (await bb.sdk.projects.list({ includePersonal: true }).catch(() => []))[0]?.id ||
      note.project_id ||
      null;
    if (!spawnProject) return [];
    let worker: { id: string } | null = null;
    const created: PracticeItemRow[] = [];
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
      const m = (out.output ?? "").match(/\[[\s\S]*\]/);
      if (m) {
        const arr = JSON.parse(m[0]) as Array<Record<string, unknown>>;
        if (Array.isArray(arr)) {
          for (const q of arr.slice(0, n)) {
            if (!q || typeof q.title !== "string") continue;
            created.push(
              insertPracticeItem(db, {
                title: String(q.title).slice(0, 200),
                topic: note.title,
                kind: typeof q.kind === "string" ? q.kind : "concept",
                question: typeof q.question === "string" ? q.question : null,
                solution: typeof q.solution === "string" ? q.solution : null,
                difficulty: typeof q.difficulty === "string" ? q.difficulty : null,
                tags: Array.isArray(q.tags) ? q.tags.map(String) : null,
                noteId,
                dueNow,
              }),
            );
          }
        }
      }
    } catch (err) {
      bb.log.warn(`generatePracticeFromNote failed: ${String(err)}`);
    } finally {
      if (worker) {
        await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
        await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => {});
      }
    }
    if (created.length) publishChanged();
    return created;
  }

  /**
   * Turn a free-form line ("two sum", "explain event loop", a pasted question)
   * into a fully-tagged practice item: a cheap agent fills topic, kind,
   * difficulty, tags, and drafts a solution. Falls back to a bare item.
   */
  async function agentPracticeParse(text: string): Promise<{
    parsed: {
      title: string; topic: string | null; kind: string; difficulty: string | null;
      question: string | null; solution: string | null; tags: string[];
    };
    usedAgent: boolean;
  }> {
    const local = {
      title: text.trim().slice(0, 200),
      topic: null as string | null,
      kind: "concept",
      difficulty: null as string | null,
      question: text.trim().length > 60 ? text.trim() : null,
      solution: null as string | null,
      tags: [] as string[],
    };
    const s = await settings.get();
    const spawnProject =
      s.atlasProjectId ||
      (await bb.sdk.projects.list({ includePersonal: true }).catch(() => []))[0]?.id ||
      null;
    if (!spawnProject) return { parsed: local, usedAgent: false };
    const prompt = `You turn a short learning prompt into a spaced-repetition practice card. Today the user is studying system design, frontend, and coding.
Return ONLY minified JSON: {"title": string, "topic": string, "kind": "concept"|"coding"|"system-design"|"frontend"|"flashcard"|"other", "difficulty": "easy"|"medium"|"hard", "question": string, "solution": string, "tags": string[]}.
- Infer topic (e.g. "System Design", "React", "DSA"), kind, and difficulty from the prompt.
- question: expand the user's short text into a COMPLETE, self-contained markdown prompt — the exact task, constraints/assumptions, and (where relevant) input/output format or a concrete example, plus what a strong answer should cover. It must be unambiguous and answerable without guessing. No vague one-liners.
- solution: a correct, detailed markdown answer/approach with the reasoning and key points (for coding, a worked solution; for system design, requirements/API/data/scale/tradeoffs).
- tags: 2-4 lowercase.
User's prompt: ${JSON.stringify(text)}`;
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
        const j = JSON.parse(m[0]) as Record<string, unknown>;
        return {
          usedAgent: true,
          parsed: {
            title: (typeof j.title === "string" && j.title.trim()) || local.title,
            topic: typeof j.topic === "string" && j.topic.trim() ? j.topic.trim() : null,
            kind: typeof j.kind === "string" ? j.kind : "concept",
            difficulty: typeof j.difficulty === "string" ? j.difficulty : null,
            question: typeof j.question === "string" ? j.question : local.question,
            solution: typeof j.solution === "string" ? j.solution : null,
            tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
          },
        };
      }
    } catch (err) {
      bb.log.warn(`agentPracticeParse fell back to local: ${String(err)}`);
    } finally {
      if (worker) {
        await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
        await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => {});
      }
    }
    return { parsed: local, usedAgent: false };
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

  /** Resolve thread ids → zThreadRef shapes (id, title, updatedAt, projectId). */
  async function resolveThreadRefs(ids: string[]): Promise<
    { id: string; title: string; updatedAt: number; projectId: string | null }[]
  > {
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
    return refs.filter((r): r is NonNullable<typeof r> => r !== null);
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
    types?: ("task" | "note" | "initiative")[] | null;
    status?: "open" | "done" | "all" | null;
    projectId?: string | null;
    limit?: number | null;
  }

  /** The second-brain query: filter tasks + notes + initiatives by text, tags,
   *  and a created/updated date window. Powers the tracker_search agent tool. */
  function searchItems(input: SearchInput): {
    tasks: TaskRow[];
    notes: NoteRow[];
    initiatives: InitiativeRow[];
  } {
    const fromMs = dayBoundMs(input.from, false);
    const toMs = dayBoundMs(input.to, true);
    const dateField = input.dateField ?? "created";
    const q = (input.query ?? "").trim().toLowerCase();
    const wantTags = (input.tags ?? []).map((t) => t.replace(/^#/, "").toLowerCase());
    const types = input.types && input.types.length ? input.types : (["task", "note", "initiative"] as const);

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
    const initiatives: InitiativeRow[] = [];
    if (types.includes("initiative")) {
      for (const r of listInitiatives(db, {}).concat(listInitiatives(db, { includeArchived: true }))) {
        if (!inRange(r.created_at, r.updated_at)) continue;
        const tags = parseInitiativeTags(r.tags);
        if (!hasTags(tags)) continue;
        const updatesText = parseUpdates(r.updates).map((u) => u.text).join(" ");
        const phasesText = parsePhases(r.phases).map((p) => p.name).join(" ");
        const hay = [r.title, r.description, tags.join(" "), updatesText, phasesText].filter(Boolean).join(" ");
        if (!matchText(hay)) continue;
        initiatives.push(r);
      }
    }
    const key = (created: number, updated: number | null | undefined) => stamp(created, updated);
    tasks.sort((a, b) => key(b.created_at, b.updated_at) - key(a.created_at, a.updated_at));
    notes.sort((a, b) => key(b.created_at, b.updated_at) - key(a.created_at, a.updated_at));
    initiatives.sort((a, b) => key(b.created_at, b.updated_at) - key(a.created_at, a.updated_at));
    const limit = input.limit ?? 50;
    return {
      tasks: tasks.slice(0, limit),
      notes: notes.slice(0, limit),
      initiatives: initiatives.slice(0, limit),
    };
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
      const prev = getTaskById(db, id)?.status ?? "open";
      const row = setStatus(db, id, status);
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      maybeHarvest(prev, row);
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async updateTask({ id, title, notes, dueDate, projectId, tags, link, links, subtasks, comments, completion, urgent }) {
      const row = updateTask(db, id, { title, notes, dueDate, projectId, tags, link, links, subtasks, comments, completion, urgent });
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async close({ id, summary, links }) {
      const prev = getTaskById(db, id)?.status ?? "open";
      const completion = formatCompletion(summary, links);
      const row = closeTask(db, id, completion || undefined);
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      maybeHarvest(prev, row, summary ?? null);
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async reorder({ id, afterId, beforeId }) {
      const row = reorderTask(db, id, afterId ?? null, beforeId ?? null);
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async setStage({ id, stage }) {
      const prev = getTaskById(db, id)?.status ?? "open";
      const row = setStage(db, id, stage);
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      maybeHarvest(prev, row);
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async archiveTask({ id, archived }) {
      const row = setArchived(db, id, archived);
      if (!row) throw new Error(`No task ${id}`);
      publishChanged();
      return { task: rowToDto(row, todayString(), await projectMap()) };
    },
    async askAgentAboutTask({ taskId, message }) {
      const row = getTaskById(db, taskId);
      if (!row) throw new Error(`No task ${taskId}`);
      const ctx = formatTaskDetail(row, await projectMap());
      const prompt = `You are acting on an item in the user's Atlas Tracker (their personal second brain). Carry out the user's request below by editing THIS task with the Atlas tools — e.g. tracker_get_task (read first), tracker_update_task (title / notes / appendNotes / dueDate / tags / addLinks / urgent / initiative), tracker_comment_task, tracker_set_task_stage, tracker_link_task, tracker_add_task (for a follow-up), tracker_close_task. Only act on this task unless the user clearly asks otherwise, and confirm what you changed.

Task reference: #${row.seq} (id: ${row.id})
Current state:
${ctx}

User's request:
${message.trim()}`;
      const s = await settings.get();
      const spawnProject =
        row.project_id ||
        (s.atlasProjectId || null) ||
        (await bb.sdk.projects.list({ includePersonal: true }).catch(() => []))[0]?.id ||
        null;
      if (!spawnProject) throw new Error("No project available to start an agent thread.");
      const worker = await bb.sdk.threads.spawn({
        projectId: spawnProject,
        environment: { type: "project-default" },
        prompt,
        visibility: "visible",
      });
      // Link the new chat to the task so it appears in the task's Linked chats.
      linkTaskThread(db, row.id, worker.id);
      logActivity(db, row.id, "linked-thread");
      publishChanged();
      return { threadId: worker.id };
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
      return { threads: await resolveThreadRefs(threadIdsForTask(db, taskId)) };
    },

    // ----- initiatives -----
    async listInitiatives({ status, archived }) {
      const rows = listInitiatives(db, {
        status: status ?? null,
        includeArchived: archived ?? false,
      });
      return { initiatives: rows.map(initiativeToDto) };
    },
    async getInitiative({ id }) {
      const row = getInitiativeById(db, id);
      if (!row) throw new Error(`No initiative ${id}`);
      const names = await projectMap();
      const today = todayString();
      const threads = await resolveThreadRefs(threadIdsForInitiative(db, id));
      return {
        initiative: initiativeToDto(row),
        tasks: tasksForInitiative(db, id).map((r) => rowToDto(r, today, names)),
        threads,
      };
    },
    async addInitiative({ title, description, status, tags, links }) {
      const row = insertInitiative(db, {
        title: title.trim(),
        description: description ?? null,
        status: status ?? "idea",
        tags: tags ?? null,
        links: links ?? null,
      });
      publishChanged();
      return { initiative: initiativeToDto(row) };
    },
    async updateInitiative({ id, title, description, status, tags, links, color }) {
      const row = updateInitiative(db, id, { title, description, status, tags, links, color });
      if (!row) throw new Error(`No initiative ${id}`);
      publishChanged();
      return { initiative: initiativeToDto(row) };
    },
    async setInitiativeStatus({ id, status }) {
      const row = setInitiativeStatus(db, id, status);
      if (!row) throw new Error(`No initiative ${id}`);
      publishChanged();
      return { initiative: initiativeToDto(row) };
    },
    async addInitiativeUpdate({ id, text, status, phaseId }) {
      const row = addInitiativeUpdate(db, id, text.trim(), status ?? null, phaseId ?? null);
      if (!row) throw new Error(`No initiative ${id}`);
      publishChanged();
      return { initiative: initiativeToDto(row) };
    },
    async setInitiativePhases({ id, phases }) {
      const row = setInitiativePhases(db, id, phases);
      if (!row) throw new Error(`No initiative ${id}`);
      publishChanged();
      return { initiative: initiativeToDto(row) };
    },
    async archiveInitiative({ id, archived }) {
      const row = setInitiativeArchived(db, id, archived);
      if (!row) throw new Error(`No initiative ${id}`);
      publishChanged();
      return { initiative: initiativeToDto(row) };
    },
    async deleteInitiative({ id }) {
      const ok = deleteInitiative(db, id);
      if (ok) publishChanged();
      return { ok };
    },
    async setTaskInitiative({ taskId, initiativeId }) {
      if (!getTaskById(db, taskId)) throw new Error(`No task ${taskId}`);
      setTaskInitiative(db, taskId, initiativeId);
      logActivity(db, taskId, "edited");
      publishChanged();
      return { task: rowToDto(getTaskById(db, taskId)!, todayString(), await projectMap()) };
    },
    async linkInitiativeThread({ initiativeId, threadId }) {
      if (!getInitiativeById(db, initiativeId)) throw new Error(`No initiative ${initiativeId}`);
      linkInitiativeThread(db, initiativeId, threadId);
      logInitiativeActivity(db, initiativeId, "linked-thread");
      publishChanged();
      return { initiative: initiativeToDto(getInitiativeById(db, initiativeId)!) };
    },
    async unlinkInitiativeThread({ initiativeId, threadId }) {
      if (!getInitiativeById(db, initiativeId)) throw new Error(`No initiative ${initiativeId}`);
      unlinkInitiativeThread(db, initiativeId, threadId);
      publishChanged();
      return { initiative: initiativeToDto(getInitiativeById(db, initiativeId)!) };
    },
    async initiativeThreadRefs({ id }) {
      return { threads: await resolveThreadRefs(threadIdsForInitiative(db, id)) };
    },
    async threadInitiatives({ threadId }) {
      return { initiatives: initiativeRowsForThread(db, threadId).map(initiativeToDto) };
    },

    // ----- practice -----
    async listPractice({ topic, kind, status, tag, search, archived }) {
      const rows = listPracticeItems(db, {
        topic: topic ?? null,
        kind: kind ?? null,
        status: status ?? null,
        tag: tag ?? null,
        search: search ?? null,
        includeArchived: archived ?? false,
      });
      return {
        items: rows.map(practiceToDto),
        topics: distinctTopics(db),
        stats: practiceStats(db),
      };
    },
    async getPractice({ id }) {
      const row = getPracticeItemById(db, id);
      if (!row) throw new Error(`No practice item ${id}`);
      return { item: practiceToDto(row) };
    },
    async addPractice({ note, ...input }) {
      const noteRow = note ? resolveNote(db, note) : null;
      const row = insertPracticeItem(db, { ...input, title: input.title.trim(), noteId: noteRow?.id ?? null });
      publishChanged();
      return { item: practiceToDto(row) };
    },
    async smartAddPractice({ text, dueNow }) {
      const { parsed, usedAgent } = await agentPracticeParse(text);
      const row = insertPracticeItem(db, {
        title: parsed.title,
        topic: parsed.topic,
        kind: parsed.kind,
        difficulty: parsed.difficulty,
        question: parsed.question,
        solution: parsed.solution,
        tags: parsed.tags.length ? parsed.tags : null,
        dueNow: dueNow ?? false,
      });
      publishChanged();
      return { item: practiceToDto(row), usedAgent };
    },
    async updatePractice({ id, ...patch }) {
      const row = updatePracticeItem(db, id, patch);
      if (!row) throw new Error(`No practice item ${id}`);
      publishChanged();
      return { item: practiceToDto(row) };
    },
    async reviewPractice({ id, grade }) {
      const row = reviewPracticeItem(db, id, grade);
      if (!row) throw new Error(`No practice item ${id}`);
      publishChanged();
      return { item: practiceToDto(row) };
    },
    async archivePractice({ id, archived }) {
      const row = setPracticeArchived(db, id, archived);
      if (!row) throw new Error(`No practice item ${id}`);
      publishChanged();
      return { item: practiceToDto(row) };
    },
    async deletePractice({ id }) {
      const ok = deletePracticeItem(db, id);
      if (ok) publishChanged();
      return { ok };
    },
    async practiceQueue({ newLimit }) {
      const { due, fresh } = dueItems(db, { newLimit: newLimit ?? 10 });
      return { due: due.map(practiceToDto), fresh: fresh.map(practiceToDto) };
    },
    async logPracticeSession({ minutes, reviewed, notes, mode, detail }) {
      const session = logSession(db, { minutes, reviewed, notes: notes ?? null, mode: mode ?? null, detail: detail ?? null });
      publishChanged();
      return { session: sessionToDto(session), stats: practiceStats(db) };
    },
    async practiceSessions({ limit }) {
      return { sessions: recentSessions(db, limit ?? 30).map(sessionToDto) };
    },
    async practiceFromNote({ noteId, count, dueNow }) {
      if (!getNoteById(db, noteId)) throw new Error(`No note ${noteId}`);
      const items = await generatePracticeFromNote(noteId, count ?? 5, dueNow ?? false);
      return { count: items.length, items: items.map(practiceToDto) };
    },
    async practiceForNote({ noteId }) {
      return { items: itemsForNote(db, noteId).map(practiceToDto) };
    },
    async startPracticeCoach({ itemId, persona, level, focus }) {
      const row = getPracticeItemById(db, itemId);
      if (!row) throw new Error(`No practice item ${itemId}`);
      const ctx = formatPracticeItem(row, { includeSolution: true });
      const p = persona ?? "teacher";
      const personaLine = {
        teacher: "You are **Atlas Coach**, a warm, encouraging senior engineer tutoring them. Socratic — you nudge, never lecture.",
        interviewer: "You are a real technical **interviewer** running a mock interview. Professional and probing: pose the problem, let them drive, give minimal hints only when they're stuck, and hold a real bar. A bit tougher; evaluate honestly.",
        peer: "You are a friendly senior **peer pairing** with them — think through it together, react naturally, build on their ideas.",
        drill: "You are a rapid-fire **quizmaster** — brisk and punchy, one quick question at a time, fast feedback.",
      }[p];
      const levelLine = level ? `Pitch everything at **${level}** level — calibrate depth, expectations, and the bar you hold them to accordingly.` : "";
      const focusLine = focus && focus.trim() ? `Focus especially on: **${focus.trim()}**.` : "";
      // Persona + context is seeded as an AGENT-ONLY message so it never shows in
      // the chat; the coach's own greeting is the first visible message.
      const seed = `## Who you are
${personaLine}
${levelLine}
${focusLine}

## How you talk (important)
Chat like a HUMAN over text — NOT like an AI. Every message SHORT: 1–3 sentences, conversational, one point at a time. No essays, headers, or big bullet lists unless they explicitly ask. React naturally, ask one thing, wait.

## What you can do
Coach them through the item below: explain or reframe the question, give progressive hints (never dump the answer unless they ask or have tried), ask a probing follow-up, keep time if asked, suggest a diagram. You can improve the item with the practice tools (practice_update / practice_get) and record a graded attempt with practice_grade_attempt after they answer. Only reveal the full solution when asked or after an attempt.

## First message
Reply with ONE short, friendly line (like a text) offering help. Don't restate the question or this persona.

## The item they're practising
${ctx}`;
      const s = await settings.get();
      const proj =
        (row.note_id ? getNoteById(db, row.note_id)?.project_id ?? null : null) ||
        s.atlasProjectId ||
        (await bb.sdk.projects.list({ includePersonal: true }).catch(() => []))[0]?.id ||
        null;
      if (!proj) throw new Error("No project available to start the coach.");
      const worker = await bb.sdk.threads.spawn({
        projectId: proj,
        environment: { type: "project-default" },
        input: [{ type: "text", text: seed, mentions: [], visibility: "agent-only" }],
        visibility: "visible",
      });
      return { threadId: worker.id };
    },
    async evaluatePracticeAttempt({ itemId, answer, seconds, mode, level }) {
      const row = getPracticeItemById(db, itemId);
      if (!row) throw new Error(`No practice item ${itemId}`);
      const s = await settings.get();
      const proj =
        s.atlasProjectId ||
        (await bb.sdk.projects.list({ includePersonal: true }).catch(() => []))[0]?.id ||
        null;
      const bare = (): { evaluated: false; grade: string; score: number | null; feedback: string; weakTags: string[]; correct: boolean; item: ReturnType<typeof practiceToDto> } => ({
        evaluated: false, grade: "good", score: null,
        feedback: "Couldn't auto-evaluate right now — grade yourself against the reference below.",
        weakTags: [], correct: false, item: practiceToDto(row),
      });
      if (!proj) return bare();
      const prompt = `You are a real teacher grading a student's answer to a practice item. Be honest but warm, specific and encouraging — like a great tutor.${level ? ` Grade at ${level} level — hold them to that bar.` : ""}
Return ONLY minified JSON: {"grade":"again"|"hard"|"good"|"easy","score":<0-100 int>,"correct":<boolean>,"feedback":<markdown string>,"weakTags":<string[]>}.
- grade: "again" = missed/incorrect, "hard" = partly right with real gaps, "good" = solid, "easy" = excellent & complete.
- feedback: SHORT and human — 2-4 sentences, conversational (not an essay, no headers/bullets). Acknowledge what's right, name the main gap (reference their answer), and ONE concrete next step.
- weakTags: 1-4 lowercase subskills/topics they should practise based on the gaps ([] if none).
Item [${row.kind}${row.difficulty ? "/" + row.difficulty : ""}] — "${row.title}"
Question:
${row.question ?? row.title}
Reference solution:
${row.solution ?? "(none provided — judge on correctness, completeness and clarity)"}
Student's answer:
${answer.trim() || "(blank)"}`;
      let workerId: string | null = null;
      try {
        const w = await bb.sdk.threads.spawn({
          projectId: proj, environment: { type: "project-default" }, prompt,
          visibility: "hidden", model: "claude-haiku-4-5-20251001",
        });
        workerId = w.id;
        await bb.sdk.threads.wait({ threadId: w.id, status: "idle" });
        const out = await bb.sdk.threads.output({ threadId: w.id });
        const m = (out.output ?? "").match(/\{[\s\S]*\}/);
        if (!m) return bare();
        const j = JSON.parse(m[0]) as Record<string, unknown>;
        const grade = (["again", "hard", "good", "easy"].includes(String(j.grade)) ? String(j.grade) : "hard") as Grade;
        const feedback = typeof j.feedback === "string" ? j.feedback : "Reviewed.";
        const weakTags = Array.isArray(j.weakTags) ? j.weakTags.map(String).slice(0, 6) : [];
        const score = typeof j.score === "number" ? Math.max(0, Math.min(100, Math.round(j.score))) : null;
        const correct = typeof j.correct === "boolean" ? j.correct : grade === "good" || grade === "easy";
        reviewPracticeItem(db, itemId, grade);
        insertAttempt(db, { itemId, answer, grade, score, feedback, weakTags, seconds: seconds ?? null, mode: mode ?? "submit" });
        publishChanged();
        return { evaluated: true, grade, score, feedback, weakTags, correct, item: practiceToDto(getPracticeItemById(db, itemId)!) };
      } catch (err) {
        bb.log.warn(`evaluatePracticeAttempt failed: ${String(err)}`);
        return bare();
      } finally {
        if (workerId) {
          await bb.sdk.threads.archive({ threadId: workerId }).catch(() => {});
          await bb.sdk.threads.stop({ threadId: workerId }).catch(() => {});
        }
      }
    },
    async practiceAttempts({ itemId, limit }) {
      return { attempts: attemptsForItem(db, itemId, limit ?? 20).map(attemptToDto) };
    },
    async practiceWeakAreas({ sinceDays }) {
      return { areas: weakAreas(db, sinceDays ?? 60) };
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
      { name: "show", summary: "Show a task in full (notes, comments, subtasks, links)", usage: "bb todo show <id>" },
      { name: "comment", summary: "Append a timestamped comment to a task (non-destructive)", usage: 'bb todo comment <id> "<text>"' },
      { name: "stage", summary: "Move a task's kanban stage", usage: "bb todo stage <id> <planned|doing|hold|done>" },
      { name: "done", summary: "Mark a task done", usage: "bb todo done <id>" },
      { name: "close", summary: "Complete a task and attach a summary / PR of what was done", usage: 'bb todo close <id> [--summary "<what was done>"] [--pr <url>] [--link <url>]' },
      { name: "undone", summary: "Reopen a task", usage: "bb todo undone <id>" },
      { name: "defer", summary: "Move a task to a later day", usage: "bb todo defer <id> --to <date>" },
      { name: "edit", summary: "Edit a task", usage: "bb todo edit <id> [--title \"<t>\"] [--due <date>] [--notes \"<n>\"] [--project <id|.>]" },
      { name: "rm", summary: "Delete a task", usage: "bb todo rm <id>" },
      { name: "note", summary: "Notes knowledge base (add/list/show/tag/rm)", usage: 'bb todo note add "<title>" [--body "<text>"] [--tag a,b] [--project <id|.>] [--task <id>]' },
      { name: "initiative", summary: "Initiatives — projects/ideas with a status board, roadmap phases & updates (add/list/show/status/update/phase/link/rm)", usage: 'bb todo initiative add "<title>" [--status active] [--desc "<text>"] [--tag a,b]' },
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
            const prev = row.status;
            const updated = setStatus(db, row.id, sub === "done" ? "done" : "open");
            publishChanged();
            maybeHarvest(prev, updated);
            const names = await projectMap();
            return {
              exitCode: 0,
              stdout: `${sub === "done" ? "Done" : "Reopened"} ${formatLine(updated!, todayString(), names)}`,
            };
          }

          case "close": {
            const row = requireTask(db, positionals[0]);
            const prev = row.status;
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
            maybeHarvest(prev, updated, summary);
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
            // Non-destructive append to notes, kept separate from a wholesale set.
            const appendNotes = flags["append-notes"];
            if (typeof appendNotes === "string" && appendNotes.trim()) {
              appendTaskNotes(db, row.id, appendNotes.trim());
              publishChanged();
            }
            const patch: Parameters<typeof updateTask>[2] = {};
            if (typeof flags.title === "string") patch.title = flags.title;
            if (typeof flags.notes === "string") patch.notes = flags.notes;
            if (typeof flags.due === "string")
              patch.dueDate = parseDueDate(flags.due);
            const proj = resolveProjectFlag();
            if (proj !== undefined) patch.projectId = proj;
            if (Object.keys(patch).length === 0 && !(typeof appendNotes === "string" && appendNotes.trim())) {
              return { exitCode: 1, stderr: 'Nothing to change. Pass --title, --due, --notes, --append-notes, or --project.' };
            }
            const updated = Object.keys(patch).length ? updateTask(db, row.id, patch) : getTaskById(db, row.id);
            if (Object.keys(patch).length) publishChanged();
            const names = await projectMap();
            return {
              exitCode: 0,
              stdout: `Updated ${formatLine(updated!, todayString(), names)}`,
            };
          }

          case "show": {
            const row = requireTask(db, positionals[0]);
            return { exitCode: 0, stdout: formatTaskDetail(row, await projectMap()) };
          }

          case "comment": {
            const row = requireTask(db, positionals[0]);
            const text = positionals.slice(1).join(" ").trim();
            if (!text) return { exitCode: 1, stderr: 'Usage: bb todo comment <id> "<text>"' };
            const updated = addTaskComment(db, row.id, text);
            publishChanged();
            const n = rowComments(updated!).length;
            return { exitCode: 0, stdout: `Added comment to #${row.seq} "${row.title}" (${n} comment${n === 1 ? "" : "s"} total).` };
          }

          case "stage": {
            const row = requireTask(db, positionals[0]);
            const prev = row.status;
            const s = positionals[1];
            const valid = ["planned", "doing", "hold", "done"];
            if (!s || !valid.includes(s)) {
              return { exitCode: 1, stderr: "Usage: bb todo stage <id> <planned|doing|hold|done>" };
            }
            const updated = setStage(db, row.id, s as "planned" | "doing" | "hold" | "done");
            publishChanged();
            maybeHarvest(prev, updated);
            const names = await projectMap();
            return { exitCode: 0, stdout: `Moved ${formatLine(updated!, todayString(), names)}` };
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

          case "init":
          case "initiative": {
            const action = positionals[0];
            const requireInit = (ref: string | undefined): InitiativeRow => {
              if (!ref) throw new Error("Which initiative? Pass its number, id, or title.");
              const i = resolveInitiative(db, ref);
              if (!i) throw new Error(`No initiative matching "${ref}".`);
              return i;
            };
            const isStatus = (s: string): s is InitiativeStatus =>
              (INITIATIVE_STATUSES as readonly string[]).includes(s);
            const fmtInit = (r: InitiativeRow): string => {
              const phs = parsePhases(r.phases);
              const active = phs.find((p) => p.status === "active");
              const nTasks = tasksForInitiative(db, r.id).length;
              return `#${r.seq} [${r.status}] ${r.title}` +
                `${active ? ` · phase: ${active.name}` : ""}` +
                `${nTasks ? ` · ${nTasks} task(s)` : ""}`;
            };
            switch (action) {
              case undefined:
              case "list": {
                const rows = listInitiatives(db, {});
                return {
                  exitCode: 0,
                  stdout: rows.length ? rows.map(fmtInit).join("\n") : "No initiatives yet.",
                };
              }
              case "add": {
                const title = positionals.slice(1).join(" ").trim();
                if (!title) return { exitCode: 1, stderr: 'Usage: bb todo initiative add "<title>" [--desc "<text>"] [--status idea|active|paused|shipped] [--tag a,b]' };
                const st = typeof flags.status === "string" && isStatus(flags.status) ? flags.status : "idea";
                const row = insertInitiative(db, {
                  title,
                  description: typeof flags.desc === "string" ? flags.desc : null,
                  status: st,
                  tags: typeof flags.tag === "string" ? flags.tag.split(",").map((t) => t.trim()) : null,
                });
                publishChanged();
                return { exitCode: 0, stdout: `Created initiative #${row.seq}: ${row.title} (${row.status})` };
              }
              case "show": {
                const r = requireInit(positionals[1]);
                const phs = parsePhases(r.phases);
                const ups = parseUpdates(r.updates);
                const tks = tasksForInitiative(db, r.id);
                const lines = [
                  `#${r.seq} ${r.title}  [${r.status}]`,
                  r.description ? `\n${r.description}` : "",
                  parseInitiativeTags(r.tags).length ? `\ntags: ${parseInitiativeTags(r.tags).join(", ")}` : "",
                  phs.length ? `\nphases:\n${phs.map((p) => `  ${p.status === "done" ? "✓" : p.status === "active" ? "▶" : "○"} ${p.name}`).join("\n")}` : "",
                  tks.length ? `\ntasks:\n${tks.map((t) => `  #${t.seq} [${t.status}] ${t.title}`).join("\n")}` : "",
                  threadIdsForInitiative(db, r.id).length ? `\nlinked chats: ${threadIdsForInitiative(db, r.id).length}` : "",
                  ups.length ? `\nupdates:\n${ups.slice(-8).map((u) => `  ${localDateString(u.at)}${u.phaseId ? ` [${phs.find((p) => p.id === u.phaseId)?.name ?? "?"}]` : ""}: ${u.text}`).join("\n")}` : "",
                ].filter(Boolean);
                return { exitCode: 0, stdout: lines.join("\n") };
              }
              case "status": {
                const r = requireInit(positionals[1]);
                const s = positionals[2];
                if (!s || !isStatus(s)) return { exitCode: 1, stderr: "Usage: bb todo initiative status <ref> <idea|active|paused|shipped>" };
                setInitiativeStatus(db, r.id, s);
                publishChanged();
                return { exitCode: 0, stdout: `#${r.seq} "${r.title}" → ${s}` };
              }
              case "update": {
                const r = requireInit(positionals[1]);
                const text = positionals.slice(2).join(" ").trim();
                if (!text) return { exitCode: 1, stderr: 'Usage: bb todo initiative update <ref> "<text>" [--status <s>] [--phase <name>]' };
                let phaseId: string | null = null;
                if (typeof flags.phase === "string" && flags.phase.trim()) {
                  const want = flags.phase.trim();
                  const phs = parsePhases(r.phases);
                  let target = phs.find((p) => p.name.toLowerCase() === want.toLowerCase());
                  if (!target) { target = { id: `ph_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: want, status: "active" }; phs.push(target); }
                  for (const p of phs) p.status = p.id === target.id ? "active" : p.status === "active" ? "done" : p.status;
                  setInitiativePhases(db, r.id, phs);
                  phaseId = target.id;
                }
                const st = typeof flags.status === "string" && isStatus(flags.status) ? flags.status : null;
                addInitiativeUpdate(db, r.id, text, st, phaseId);
                publishChanged();
                return { exitCode: 0, stdout: `Logged update on #${r.seq} "${r.title}"${flags.phase ? ` · phase ${String(flags.phase)}` : ""}${st ? ` · ${st}` : ""}` };
              }
              case "phase": {
                const r = requireInit(positionals[1]);
                const name = positionals.slice(2).join(" ").trim();
                if (!name) return { exitCode: 1, stderr: "Usage: bb todo initiative phase <ref> <name>   (creates if new, marks it the active phase)" };
                const phs = parsePhases(r.phases);
                let target = phs.find((p) => p.name.toLowerCase() === name.toLowerCase());
                if (!target) { target = { id: `ph_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name, status: "active" }; phs.push(target); }
                for (const p of phs) p.status = p.id === target.id ? "active" : p.status === "active" ? "done" : p.status;
                setInitiativePhases(db, r.id, phs);
                publishChanged();
                return { exitCode: 0, stdout: `#${r.seq} "${r.title}" → phase: ${name}` };
              }
              case "link": {
                const r = requireInit(positionals[1]);
                const tid = positionals[2];
                if (!tid) return { exitCode: 1, stderr: "Usage: bb todo initiative link <ref> <threadId>" };
                linkInitiativeThread(db, r.id, tid);
                logInitiativeActivity(db, r.id, "linked-thread");
                publishChanged();
                return { exitCode: 0, stdout: `Linked thread ${tid} to initiative #${r.seq} "${r.title}".` };
              }
              case "rm":
              case "delete": {
                const r = requireInit(positionals[1]);
                deleteInitiative(db, r.id);
                publishChanged();
                return { exitCode: 0, stdout: `Deleted initiative #${r.seq}: ${r.title}` };
              }
              default:
                return { exitCode: 1, stderr: `Unknown initiative command "${action}". Try: add, list, show, status, update, phase, link, rm.` };
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

  // ----- Native agent tool: create a task ------------------------------
  bb.agents.registerTool({
    name: "tracker_add_task",
    description:
      "Create a task (todo) in the user's Atlas Tracker. Use when the user asks to add/create a task or capture a todo, or when you agree to track a concrete piece of work. Supports a due date, tags, urgency, a starting kanban stage, and filing it under an initiative. Links the current chat to the task by default so it shows in the thread's info panel.",
    instructions:
      "When the user asks to add a todo/task (or you commit to tracked work), call tracker_add_task with a concise imperative title and any details they gave (notes, 2-5 lowercase tags, dueDate YYYY-MM-DD, urgent, stage, initiative). It links the current thread automatically unless linkThread:false.",
    presentation: { label: { pending: "Adding task", completed: "Added task" } },
    parameters: z.object({
      title: z.string().describe("Concise imperative task title."),
      notes: z.string().optional().describe("Optional description / details."),
      tags: z.array(z.string()).optional().describe("2-5 lowercase single-word tags (no '#')."),
      dueDate: z.string().regex(ISO_DATE).optional().describe("Due date YYYY-MM-DD, if any."),
      urgent: z.boolean().optional().describe("Flag as urgent (floats to the top)."),
      stage: z
        .enum(["planned", "doing", "hold"])
        .optional()
        .describe("Starting kanban stage (default 'planned')."),
      initiative: z
        .string()
        .optional()
        .describe("Optional initiative reference (number/id/title) to file the task under."),
      projectId: z.string().optional().describe("Optional bb project id."),
      links: z.array(z.string()).optional().describe("Optional related URLs (PRs, docs, Slack)."),
      linkThread: z
        .boolean()
        .optional()
        .describe("Link the current chat to the task (default true)."),
    }),
    async execute({ title, notes, tags, dueDate, urgent, stage, initiative, projectId, links, linkThread }, context) {
      let initiativeId: string | null = null;
      if (initiative) {
        const ir = resolveInitiative(db, initiative);
        if (!ir) {
          return {
            content: [{ type: "text", text: `No initiative matching "${initiative}".` }],
            isError: true,
          };
        }
        initiativeId = ir.id;
      }
      const row = insertTask(db, {
        title: title.trim(),
        projectId: projectId ?? null,
        dueDate: dueDate ?? null,
        notes: notes ?? null,
        tags: tags && tags.length ? tags : null,
        link: null,
      });
      if (stage && stage !== "planned") setStage(db, row.id, stage);
      if (urgent || (links && links.length)) {
        updateTask(db, row.id, {
          urgent: urgent ?? undefined,
          links: links ?? undefined,
        });
      }
      if (initiativeId) setTaskInitiative(db, row.id, initiativeId);
      const linkedChat = (linkThread ?? true) && context.threadId;
      if (linkedChat) {
        linkTaskThread(db, row.id, context.threadId!);
        logActivity(db, row.id, "linked-thread");
      }
      publishChanged();
      const final = getTaskById(db, row.id)!;
      const tg = parseTags(final.tags);
      return (
        `Added task #${final.seq} "${final.title}"` +
        `${tg.length ? ` [${tg.join(", ")}]` : ""}` +
        `${final.due_date ? ` · due ${final.due_date}` : ""}` +
        `${initiativeId ? ` · filed under initiative` : ""}` +
        `${linkedChat ? " · linked to this chat" : ""}.`
      );
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
      const prev = row.status;
      const completion = formatCompletion(summary, links);
      const updated = closeTask(db, row.id, completion || undefined);
      publishChanged();
      maybeHarvest(prev, updated, summary ?? null);
      return `Closed "${updated!.title}" in the Tracker and attached the completion note. A knowledge-base note will be harvested from it.`;
    },
  });

  // ----- Native agent tool: harvest a task into the knowledge base -----
  bb.agents.registerTool({
    name: "tracker_harvest_task",
    description:
      "Process a task into a knowledge-base note now — analyze what was done and save the learnings as a note linked to the task and its chats. This runs automatically when a task is completed, but call it explicitly to (re)harvest, or after adding a completion note that should be folded into the knowledge base. Pass `note` to add your own processing note into the mix.",
    instructions:
      "After a task is completed (or when the user wants to capture what was learned), call tracker_harvest_task with the task reference; pass `note` to include an extra completion note to process into the knowledge base.",
    presentation: { label: { pending: "Harvesting to KB", completed: "Harvested to KB" } },
    parameters: z.object({
      task: z.string().describe("Task reference: number, id, or part of its title."),
      note: z.string().optional().describe("Optional completion note to record and fold into the knowledge-base note."),
    }),
    async execute({ task, note }) {
      const row = resolveTask(db, task);
      if (!row) {
        return { content: [{ type: "text", text: `No Tracker task matching "${task}".` }], isError: true };
      }
      if (note && note.trim()) addTaskComment(db, row.id, note.trim());
      const res = await harvestTaskToKb(row.id, { extraNote: note ?? null, force: true });
      publishChanged();
      return res
        ? `Harvested task #${row.seq} "${row.title}" → knowledge-base note #${res.noteSeq} "${res.noteTitle}".`
        : `Couldn't harvest task #${row.seq} right now (agent unavailable). Try again shortly.`;
    },
  });

  // ----- Native agent tool: read a task in full ------------------------
  bb.agents.registerTool({
    name: "tracker_get_task",
    description:
      "Read a single task from the user's Atlas Tracker in full — its title, stage, status, due date, tags, notes/description, subtasks, comments, links, initiative, and linked-chat count. Use this before editing or commenting on a task so you don't overwrite existing content.",
    instructions:
      "Before you edit or comment on a Tracker task, call tracker_get_task first to see its current notes and comments so nothing is lost.",
    presentation: { label: { pending: "Reading task", completed: "Read task" } },
    parameters: z.object({
      task: z.string().describe("Task reference: its number (e.g. 8), id, or a distinctive part of its title."),
    }),
    async execute({ task }) {
      const row = resolveTask(db, task);
      if (!row) {
        return { content: [{ type: "text", text: `No Tracker task matching "${task}".` }], isError: true };
      }
      return formatTaskDetail(row, await projectMap());
    },
  });

  // ----- Native agent tool: append a comment to a task -----------------
  bb.agents.registerTool({
    name: "tracker_comment_task",
    description:
      "Append a timestamped comment to a task's progress log in the user's Atlas Tracker. Non-destructive — it adds to the task's comment history and never touches the notes/description. Use to record a status update, a decision, or what happened, so the task stays trackable over time.",
    instructions:
      "When the user reports progress or a status update on a specific task, call tracker_comment_task with the task reference and the update text. This appends a timestamped comment; it does not overwrite the task's notes.",
    presentation: { label: { pending: "Commenting on task", completed: "Commented on task" } },
    parameters: z.object({
      task: z.string().describe("Task reference: number, id, or part of its title."),
      comment: z.string().describe("The comment / progress update to append."),
    }),
    async execute({ task, comment }) {
      const row = resolveTask(db, task);
      if (!row) {
        return { content: [{ type: "text", text: `No Tracker task matching "${task}".` }], isError: true };
      }
      const updated = addTaskComment(db, row.id, comment.trim());
      publishChanged();
      return `Added a comment to task #${updated!.seq} "${updated!.title}".`;
    },
  });

  // ----- Native agent tool: move a task's kanban stage ----------------
  bb.agents.registerTool({
    name: "tracker_set_task_stage",
    description:
      "Move a task to a kanban stage in the user's Atlas Tracker: planned, doing (in progress), hold (on hold), or done. Use when the user says a task is now in progress, on hold, in QA/doing, or finished. Setting 'done' completes the task.",
    instructions:
      "When the user changes where a task sits on the board (start it, park it, finish it), call tracker_set_task_stage with the task reference and the stage.",
    presentation: { label: { pending: "Moving task", completed: "Moved task" } },
    parameters: z.object({
      task: z.string().describe("Task reference: number, id, or part of its title."),
      stage: z.enum(["planned", "doing", "hold", "done"]).describe("Target kanban stage."),
    }),
    async execute({ task, stage }) {
      const row = resolveTask(db, task);
      if (!row) {
        return { content: [{ type: "text", text: `No Tracker task matching "${task}".` }], isError: true };
      }
      const prev = row.status;
      const updated = setStage(db, row.id, stage);
      publishChanged();
      maybeHarvest(prev, updated);
      const label = stage === "doing" ? "In Progress" : stage === "hold" ? "On Hold" : stage === "done" ? "Done" : "Planned";
      return `Moved task #${updated!.seq} "${updated!.title}" → ${label}.`;
    },
  });

  // ----- Native agent tool: edit any field of a task ------------------
  bb.agents.registerTool({
    name: "tracker_update_task",
    description:
      "Edit an existing task in the user's Atlas Tracker: title, description/notes (replace or append), due date, tags, add links, urgency, and which initiative it belongs to. Read the task first with tracker_get_task if you might overwrite content. For stage use tracker_set_task_stage, for a progress note use tracker_comment_task.",
    instructions:
      "When the user asks to change a task's details, call tracker_update_task with the task reference and only the fields that change. Use appendNotes to add to the description without overwriting it; notes replaces it wholesale. dueDate 'none' clears the due date; initiative 'none' unassigns it.",
    presentation: { label: { pending: "Updating task", completed: "Updated task" } },
    parameters: z.object({
      task: z.string().describe("Task reference: number, id, or part of its title."),
      title: z.string().optional().describe("New title."),
      notes: z.string().optional().describe("Replace the description/notes wholesale."),
      appendNotes: z.string().optional().describe("Append to the description (non-destructive)."),
      dueDate: z.string().optional().describe("YYYY-MM-DD, or 'none' to clear."),
      tags: z.array(z.string()).optional().describe("Replace the full tag set (lowercase, no '#')."),
      addLinks: z.array(z.string()).optional().describe("Append these URLs to the task's links."),
      urgent: z.boolean().optional().describe("Flag/unflag as urgent."),
      initiative: z.string().optional().describe("Initiative ref to file it under, or 'none' to unassign."),
    }),
    async execute({ task, title, notes, appendNotes, dueDate, tags, addLinks, urgent, initiative }) {
      const row = resolveTask(db, task);
      if (!row) return { content: [{ type: "text", text: `No Tracker task matching "${task}".` }], isError: true };
      if (appendNotes && appendNotes.trim()) appendTaskNotes(db, row.id, appendNotes.trim());
      const patch: Parameters<typeof updateTask>[2] = {};
      if (typeof title === "string") patch.title = title;
      if (typeof notes === "string") patch.notes = notes || null;
      if (typeof dueDate === "string") patch.dueDate = dueDate.toLowerCase() === "none" ? null : dueDate;
      if (Array.isArray(tags)) patch.tags = tags;
      if (typeof urgent === "boolean") patch.urgent = urgent;
      if (Array.isArray(addLinks) && addLinks.length) {
        let cur: string[] = [];
        try { if (row.links) { const j = JSON.parse(row.links); if (Array.isArray(j)) cur = j.map(String); } } catch { /* ignore */ }
        if (row.link && !cur.includes(row.link)) cur = [row.link, ...cur];
        patch.links = [...new Set([...cur, ...addLinks.map((l) => l.trim()).filter(Boolean)])];
      }
      if (Object.keys(patch).length) updateTask(db, row.id, patch);
      if (typeof initiative === "string") {
        if (initiative.trim().toLowerCase() === "none" || initiative.trim() === "") {
          setTaskInitiative(db, row.id, null);
        } else {
          const ir = resolveInitiative(db, initiative);
          if (!ir) return { content: [{ type: "text", text: `No initiative matching "${initiative}".` }], isError: true };
          setTaskInitiative(db, row.id, ir.id);
        }
      }
      publishChanged();
      const final = getTaskById(db, row.id)!;
      return `Updated task #${final.seq} "${final.title}".`;
    },
  });

  // ----- Native agent tool: archive / unarchive a task ----------------
  bb.agents.registerTool({
    name: "tracker_archive_task",
    description:
      "Archive a task (hide it from the board while keeping all its data) or restore it. Use when the user wants to get a task off the board without deleting it, or to bring one back.",
    instructions: "Call tracker_archive_task to hide a task from the board (archived:true) or restore it (archived:false).",
    presentation: { label: { pending: "Archiving task", completed: "Archived task" } },
    parameters: z.object({
      task: z.string().describe("Task reference: number, id, or part of its title."),
      archived: z.boolean().optional().describe("true to archive (default), false to restore."),
    }),
    async execute({ task, archived }) {
      const row = resolveTask(db, task);
      if (!row) return { content: [{ type: "text", text: `No Tracker task matching "${task}".` }], isError: true };
      const val = archived ?? true;
      setArchived(db, row.id, val);
      publishChanged();
      return `${val ? "Archived" : "Restored"} task #${row.seq} "${row.title}".`;
    },
  });

  // ----- Native agent tool: delete a task -----------------------------
  bb.agents.registerTool({
    name: "tracker_delete_task",
    description:
      "Permanently delete a task from the user's Atlas Tracker. This cannot be undone — prefer tracker_archive_task unless the user clearly wants it gone. Use only on an explicit delete request.",
    instructions: "Only call tracker_delete_task when the user explicitly asks to delete/remove a task for good; otherwise archive it.",
    presentation: { label: { pending: "Deleting task", completed: "Deleted task" } },
    parameters: z.object({
      task: z.string().describe("Task reference: number, id, or part of its title."),
    }),
    async execute({ task }) {
      const row = resolveTask(db, task);
      if (!row) return { content: [{ type: "text", text: `No Tracker task matching "${task}".` }], isError: true };
      deleteTask(db, row.id);
      publishChanged();
      return `Deleted task #${row.seq} "${row.title}".`;
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

  // ----- Native agent tool: read a note --------------------------------
  bb.agents.registerTool({
    name: "tracker_get_note",
    description:
      "Read a single note from the user's Atlas knowledge base in full — title, tags, body (markdown, may contain [[wikilinks]]), the task it relates to, and linked chats. Use before editing a note so you don't overwrite its body.",
    instructions: "Call tracker_get_note before editing a note to see its current body and tags.",
    presentation: { label: { pending: "Reading note", completed: "Read note" } },
    parameters: z.object({ note: z.string().describe("Note reference: number, id, or part of its title.") }),
    async execute({ note }) {
      const row = resolveNote(db, note);
      if (!row) return { content: [{ type: "text", text: `No note matching "${note}".` }], isError: true };
      const tags = parseTags(row.tags);
      const lines = [
        `#${row.seq}  ${row.title}`,
        tags.length ? `tags: ${tags.join(", ")}` : "",
        `created ${new Date(row.created_at).toLocaleString()}${row.updated_at !== row.created_at ? ` · updated ${new Date(row.updated_at).toLocaleString()}` : ""}`,
        row.body.trim() ? `\n${row.body.trim()}` : "",
      ].filter(Boolean);
      return lines.join("\n");
    },
  });

  // ----- Native agent tool: edit a note --------------------------------
  bb.agents.registerTool({
    name: "tracker_update_note",
    description:
      "Edit an existing note in the user's Atlas knowledge base: title, body (replace or append), and tags. Read it first with tracker_get_note if you might overwrite the body.",
    instructions: "Call tracker_update_note with the note reference and only the fields to change. Use appendBody to add without overwriting; body replaces wholesale.",
    presentation: { label: { pending: "Updating note", completed: "Updated note" } },
    parameters: z.object({
      note: z.string().describe("Note reference: number, id, or part of its title."),
      title: z.string().optional(),
      body: z.string().optional().describe("Replace the body wholesale (markdown)."),
      appendBody: z.string().optional().describe("Append to the body (non-destructive)."),
      tags: z.array(z.string()).optional().describe("Replace the full tag set."),
    }),
    async execute({ note, title, body, appendBody, tags }) {
      const row = resolveNote(db, note);
      if (!row) return { content: [{ type: "text", text: `No note matching "${note}".` }], isError: true };
      const patch: Parameters<typeof updateNote>[2] = {};
      if (typeof title === "string") patch.title = title;
      if (typeof body === "string") patch.body = body;
      else if (typeof appendBody === "string" && appendBody.trim()) {
        const cur = (row.body ?? "").trimEnd();
        patch.body = cur ? `${cur}\n\n${appendBody.trim()}` : appendBody.trim();
      }
      if (Array.isArray(tags)) patch.tags = tags;
      updateNote(db, row.id, patch);
      publishChanged();
      const final = getNoteById(db, row.id)!;
      return `Updated note #${final.seq} "${final.title}".`;
    },
  });

  // ----- Native agent tool: delete a note ------------------------------
  bb.agents.registerTool({
    name: "tracker_delete_note",
    description: "Permanently delete a note from the user's Atlas knowledge base. Cannot be undone; use only on an explicit delete request.",
    instructions: "Only call tracker_delete_note when the user explicitly wants a note gone.",
    presentation: { label: { pending: "Deleting note", completed: "Deleted note" } },
    parameters: z.object({ note: z.string().describe("Note reference: number, id, or part of its title.") }),
    async execute({ note }) {
      const row = resolveNote(db, note);
      if (!row) return { content: [{ type: "text", text: `No note matching "${note}".` }], isError: true };
      deleteNote(db, row.id);
      publishChanged();
      return `Deleted note #${row.seq} "${row.title}".`;
    },
  });

  // ----- Native agent tool: search the second brain (tasks + notes) -----
  bb.agents.registerTool({
    name: "tracker_search",
    description:
      "Search the user's Atlas second brain — their personal tasks, notes, and initiatives — by free text, tags, and a created/updated date range. Use this to answer questions like 'what promotion tasks did I add in August', 'notes I edited last week', 'open tasks tagged design', or 'which initiatives are in the build phase'. Dates are YYYY-MM-DD; pick dateField 'created' (default, = when it was added) or 'updated' (= last edited). Initiative haystack includes its description, phases and updates.",
    instructions:
      "When the user asks to find or recall their own tasks/notes by topic and/or time (e.g. 'what did I add in August about X'), translate it into tracker_search: put the topic in `query`, the month/period into `from`/`to` (YYYY-MM-DD), and choose dateField 'created' for 'added' or 'updated' for 'edited/touched'.",
    presentation: { label: { pending: "Searching Atlas", completed: "Searched Atlas" } },
    parameters: z.object({
      query: z.string().optional().describe("free text to match in title, notes/body, tags, and comments"),
      tags: z.array(z.string()).optional().describe("only items carrying any of these tags"),
      from: z.string().regex(ISO_DATE).optional().describe("start date YYYY-MM-DD (inclusive)"),
      to: z.string().regex(ISO_DATE).optional().describe("end date YYYY-MM-DD (inclusive)"),
      dateField: z.enum(["created", "updated"]).optional().describe("'created' = when added (default); 'updated' = last edited"),
      types: z.array(z.enum(["task", "note", "initiative"])).optional().describe("restrict to tasks, notes, and/or initiatives"),
      status: z.enum(["open", "done", "all"]).optional().describe("task status filter"),
      limit: z.number().int().optional(),
    }),
    async execute({ query, tags, from, to, dateField, types, status, limit }) {
      const { tasks, notes, initiatives } = searchItems({ query, tags, from, to, dateField, types, status, limit });
      const names = await projectMap();
      const d = (ms: number) => localDateString(ms);
      const span = from || to ? ` in ${dateField ?? "created"} range ${from ?? "…"}–${to ?? "…"}` : "";
      const lines: string[] = [
        `Found ${tasks.length} task(s), ${notes.length} note(s) and ${initiatives.length} initiative(s)${query ? ` matching "${query}"` : ""}${span}.`,
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
      if (initiatives.length) {
        lines.push("", "Initiatives:");
        for (const it of initiatives) {
          const tg = parseInitiativeTags(it.tags);
          const active = parsePhases(it.phases).find((p) => p.status === "active");
          const upd = it.updated_at && it.updated_at !== it.created_at ? ` · updated ${d(it.updated_at)}` : "";
          lines.push(
            `- #${it.seq} ${it.title} · ${it.status}${active ? `/${active.name}` : ""} · created ${d(it.created_at)}${upd}` +
              `${tg.length ? ` · [${tg.join(", ")}]` : ""}${it.archived_at ? " · archived" : ""}`,
          );
        }
      }
      if (!tasks.length && !notes.length && !initiatives.length) lines.push("No matches — try a wider date range or fewer filters.");
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

  // ----- Native agent tool: create an initiative ------------------------
  bb.agents.registerTool({
    name: "tracker_add_initiative",
    description:
      "Create an initiative in the user's Atlas second brain — a project, idea, or effort that groups tasks and tracks its own state (idea/active/paused/shipped) and a timeline of updates. Use when the user starts something bigger than a single task ('new initiative', 'let's track this project/idea'). Links the current chat to it by default.",
    instructions:
      "When the user frames a project/idea/effort worth tracking over time (not a single todo), call tracker_add_initiative with a concise title, a one-paragraph description, an initial status, and 2-5 lowercase tags. It links the current thread automatically.",
    presentation: { label: { pending: "Creating initiative", completed: "Created initiative" } },
    parameters: z.object({
      title: z.string().describe("Concise name of the initiative."),
      description: z.string().optional().describe("What it is and the goal (a short paragraph)."),
      status: z
        .enum(["idea", "active", "paused", "shipped"])
        .optional()
        .describe("Initial state (default 'idea')."),
      tags: z.array(z.string()).optional().describe("2-5 lowercase single-word tags."),
      linkThread: z
        .boolean()
        .optional()
        .describe("Link the current chat to the initiative (default true)."),
    }),
    async execute({ title, description, status, tags }, context) {
      const row = insertInitiative(db, {
        title: title.trim(),
        description: description ?? null,
        status: status ?? "idea",
        tags: tags && tags.length ? tags : null,
      });
      if (context.threadId) {
        linkInitiativeThread(db, row.id, context.threadId);
        logInitiativeActivity(db, row.id, "linked-thread");
      }
      publishChanged();
      return `Created initiative #${row.seq} "${row.title}" (${row.status})${context.threadId ? " and linked this chat" : ""}.`;
    },
  });

  // ----- Native agent tool: post an initiative update -------------------
  bb.agents.registerTool({
    name: "tracker_update_initiative",
    description:
      "Post a progress update to an Atlas initiative and optionally change its overall state (idea/active/paused/shipped) or the roadmap phase it's in (e.g. Design, Build, Launch). Updates are timestamped and tagged with their phase, so the user gets the full step-by-step history of each stage. Use when the user reports progress, a decision, a state change, or moving to the next phase.",
    instructions:
      "When the user reports progress on an initiative, call tracker_update_initiative with the initiative reference and a concise update. Pass `phase` when the work belongs to (or moves into) a named stage like 'Design' or 'Build' — it activates that phase, creating it if new. Pass `status` only for the overall lifecycle state.",
    presentation: { label: { pending: "Updating initiative", completed: "Updated initiative" } },
    parameters: z.object({
      initiative: z
        .string()
        .describe("Initiative reference: its number, id, or a distinctive part of its title."),
      update: z.string().describe("A concise progress update / note."),
      status: z
        .enum(["idea", "active", "paused", "shipped"])
        .optional()
        .describe("New overall lifecycle state, if it changed."),
      phase: z
        .string()
        .optional()
        .describe("Roadmap phase this update belongs to (e.g. 'Design'). Activated, and created if it doesn't exist."),
    }),
    async execute({ initiative, update, status, phase }) {
      const row = resolveInitiative(db, initiative);
      if (!row) {
        return {
          content: [{ type: "text", text: `No initiative matching "${initiative}".` }],
          isError: true,
        };
      }
      let phaseId: string | null = null;
      if (phase && phase.trim()) {
        const want = phase.trim();
        const phases = parsePhases(row.phases);
        let target = phases.find((p) => p.name.toLowerCase() === want.toLowerCase());
        if (!target) {
          target = {
            id: `ph_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
            name: want,
            status: "active",
          };
          phases.push(target);
        }
        // Single active phase: activate this one, demote any other active to done.
        for (const p of phases) {
          if (p.id === target.id) p.status = "active";
          else if (p.status === "active") p.status = "done";
        }
        setInitiativePhases(db, row.id, phases);
        phaseId = target.id;
      }
      const updated = addInitiativeUpdate(db, row.id, update.trim(), status ?? null, phaseId);
      publishChanged();
      return `Logged an update on initiative #${updated!.seq} "${updated!.title}"${phase ? ` · phase ${phase.trim()}` : ""}${status ? ` · now ${status}` : ""}.`;
    },
  });

  // ----- Native agent tool: link a chat to an initiative ----------------
  bb.agents.registerTool({
    name: "tracker_link_initiative",
    description:
      "Link a bb chat thread to an Atlas initiative, so the chat shows in the initiative and the initiative shows in the thread's info panel. Defaults to the current chat. Use when the user says 'link this thread to the <name> initiative'.",
    instructions:
      "When the user wants to connect a chat to an initiative, call tracker_link_initiative with the initiative reference. Omit threadId for the current chat; set unlink:true to remove.",
    presentation: { label: { pending: "Linking initiative", completed: "Linked initiative" } },
    parameters: z.object({
      initiative: z.string().describe("Initiative reference: number, id, or part of its title."),
      threadId: z.string().optional().describe("Thread to link; defaults to the current chat."),
      unlink: z.boolean().optional().describe("Remove the link instead of adding it."),
    }),
    async execute({ initiative, threadId, unlink }, context) {
      const tid = threadId ?? context.threadId ?? null;
      if (!tid) {
        return {
          content: [{ type: "text", text: "No thread to link — run this from inside a chat or pass threadId." }],
          isError: true,
        };
      }
      const row = resolveInitiative(db, initiative);
      if (!row) {
        return {
          content: [{ type: "text", text: `No initiative matching "${initiative}".` }],
          isError: true,
        };
      }
      if (unlink) {
        unlinkInitiativeThread(db, row.id, tid);
        publishChanged();
        return `Unlinked this chat from initiative #${row.seq} "${row.title}".`;
      }
      linkInitiativeThread(db, row.id, tid);
      logInitiativeActivity(db, row.id, "linked-thread");
      publishChanged();
      return `Linked this chat to initiative #${row.seq} "${row.title}".`;
    },
  });

  // ----- Native agent tool: read an initiative in full -----------------
  bb.agents.registerTool({
    name: "tracker_get_initiative",
    description:
      "Read a single initiative from the user's Atlas Tracker in full — description, overall status, roadmap phases (and which is active), its tasks, links, the update timeline, and linked-chat count. Use before editing an initiative or posting an update so you have the current picture.",
    instructions: "Call tracker_get_initiative to see an initiative's phases, tasks and update history before changing it.",
    presentation: { label: { pending: "Reading initiative", completed: "Read initiative" } },
    parameters: z.object({ initiative: z.string().describe("Initiative reference: number, id, or part of its title.") }),
    async execute({ initiative }) {
      const row = resolveInitiative(db, initiative);
      if (!row) return { content: [{ type: "text", text: `No initiative matching "${initiative}".` }], isError: true };
      return formatInitiativeDetail(row);
    },
  });

  // ----- Native agent tool: edit an initiative -------------------------
  bb.agents.registerTool({
    name: "tracker_edit_initiative",
    description:
      "Edit an initiative's core fields: title, description (replace or append), overall status (idea/active/paused/shipped), tags, and add links. For a progress note or a phase change use tracker_update_initiative; for roadmap phases use tracker_set_initiative_phase.",
    instructions: "Call tracker_edit_initiative with the initiative reference and only the fields to change. appendDescription adds without overwriting; description replaces wholesale.",
    presentation: { label: { pending: "Editing initiative", completed: "Edited initiative" } },
    parameters: z.object({
      initiative: z.string().describe("Initiative reference: number, id, or part of its title."),
      title: z.string().optional(),
      description: z.string().optional().describe("Replace the description wholesale (markdown)."),
      appendDescription: z.string().optional().describe("Append to the description (non-destructive)."),
      status: z.enum(["idea", "active", "paused", "shipped"]).optional(),
      tags: z.array(z.string()).optional().describe("Replace the full tag set."),
      addLinks: z.array(z.string()).optional().describe("Append these URLs."),
    }),
    async execute({ initiative, title, description, appendDescription, status, tags, addLinks }) {
      const row = resolveInitiative(db, initiative);
      if (!row) return { content: [{ type: "text", text: `No initiative matching "${initiative}".` }], isError: true };
      const patch: Parameters<typeof updateInitiative>[2] = {};
      if (typeof title === "string") patch.title = title;
      if (typeof description === "string") patch.description = description || null;
      else if (typeof appendDescription === "string" && appendDescription.trim()) {
        const cur = (row.description ?? "").trimEnd();
        patch.description = cur ? `${cur}\n\n${appendDescription.trim()}` : appendDescription.trim();
      }
      if (typeof status === "string") patch.status = status;
      if (Array.isArray(tags)) patch.tags = tags;
      if (Array.isArray(addLinks) && addLinks.length) {
        patch.links = [...new Set([...parseInitiativeLinks(row.links), ...addLinks.map((l) => l.trim()).filter(Boolean)])];
      }
      updateInitiative(db, row.id, patch);
      publishChanged();
      const final = getInitiativeById(db, row.id)!;
      return `Updated initiative #${final.seq} "${final.title}"${status ? ` (${status})` : ""}.`;
    },
  });

  // ----- Native agent tool: manage a roadmap phase --------------------
  bb.agents.registerTool({
    name: "tracker_set_initiative_phase",
    description:
      "Manage the roadmap phases of an initiative (e.g. Design, Build, Launch): add a phase, set its status (pending/active/done), or remove it. Setting a phase 'active' makes it the current stage and marks any previously-active phase done. Use to shape or advance an initiative's roadmap.",
    instructions: "Call tracker_set_initiative_phase with the initiative and phase name. status sets that phase's state (default: add as active / activate). remove:true deletes the phase.",
    presentation: { label: { pending: "Updating roadmap", completed: "Updated roadmap" } },
    parameters: z.object({
      initiative: z.string().describe("Initiative reference: number, id, or part of its title."),
      phase: z.string().describe("Phase name (created if it doesn't exist)."),
      status: z.enum(["pending", "active", "done"]).optional().describe("Phase status to set (default: active)."),
      remove: z.boolean().optional().describe("Remove this phase instead."),
    }),
    async execute({ initiative, phase, status, remove }) {
      const row = resolveInitiative(db, initiative);
      if (!row) return { content: [{ type: "text", text: `No initiative matching "${initiative}".` }], isError: true };
      const want = phase.trim();
      const phases = parsePhases(row.phases);
      if (remove) {
        const next = phases.filter((p) => p.name.toLowerCase() !== want.toLowerCase());
        setInitiativePhases(db, row.id, next);
        publishChanged();
        return `Removed phase "${want}" from initiative #${row.seq} "${row.title}".`;
      }
      const target = phases.find((p) => p.name.toLowerCase() === want.toLowerCase());
      const st = status ?? "active";
      if (!target) {
        phases.push({ id: `ph_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: want, status: st });
      } else {
        target.status = st;
      }
      if (st === "active") {
        for (const p of phases) if (p.name.toLowerCase() !== want.toLowerCase() && p.status === "active") p.status = "done";
      }
      setInitiativePhases(db, row.id, phases);
      publishChanged();
      return `Set phase "${want}" → ${st} on initiative #${row.seq} "${row.title}".`;
    },
  });

  // ----- Native agent tool: archive / delete an initiative ------------
  bb.agents.registerTool({
    name: "tracker_archive_initiative",
    description: "Archive an initiative (hide it from the board, keep its data) or restore it.",
    instructions: "Call tracker_archive_initiative to hide (archived:true) or restore (archived:false) an initiative.",
    presentation: { label: { pending: "Archiving initiative", completed: "Archived initiative" } },
    parameters: z.object({
      initiative: z.string().describe("Initiative reference: number, id, or part of its title."),
      archived: z.boolean().optional().describe("true to archive (default), false to restore."),
    }),
    async execute({ initiative, archived }) {
      const row = resolveInitiative(db, initiative);
      if (!row) return { content: [{ type: "text", text: `No initiative matching "${initiative}".` }], isError: true };
      const val = archived ?? true;
      setInitiativeArchived(db, row.id, val);
      publishChanged();
      return `${val ? "Archived" : "Restored"} initiative #${row.seq} "${row.title}".`;
    },
  });

  bb.agents.registerTool({
    name: "tracker_delete_initiative",
    description: "Permanently delete an initiative (its tasks are kept but unassigned). Cannot be undone; use only on an explicit delete request — prefer archiving.",
    instructions: "Only call tracker_delete_initiative when the user explicitly wants it gone for good.",
    presentation: { label: { pending: "Deleting initiative", completed: "Deleted initiative" } },
    parameters: z.object({ initiative: z.string().describe("Initiative reference: number, id, or part of its title.") }),
    async execute({ initiative }) {
      const row = resolveInitiative(db, initiative);
      if (!row) return { content: [{ type: "text", text: `No initiative matching "${initiative}".` }], isError: true };
      deleteInitiative(db, row.id);
      publishChanged();
      return `Deleted initiative #${row.seq} "${row.title}".`;
    },
  });

  // ===== Practice (spaced-repetition learning) agent tools ==============
  function formatPracticeItem(row: PracticeItemRow, opts: { includeSolution?: boolean } = {}): string {
    const d = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "—");
    const tags = parsePracticeTags(row.tags);
    const lines = [
      `#${row.seq}  ${row.title}   [${row.kind}${row.difficulty ? "/" + row.difficulty : ""}]  · ${row.status}`,
      `${row.topic ? `topic: ${row.topic}  ·  ` : ""}due: ${d(row.due_at)}  ·  reps: ${row.reps}  ·  interval: ${Math.round(row.interval_days)}d${row.lapses ? `  ·  lapses: ${row.lapses}` : ""}`,
      tags.length ? `tags: ${tags.join(", ")}` : "",
      row.source ? `source: ${row.source}` : "",
      row.question ? `\nQuestion:\n${row.question}` : "",
      opts.includeSolution && row.solution ? `\nSolution:\n${row.solution}` : "",
    ].filter(Boolean);
    return lines.join("\n");
  }

  bb.agents.registerTool({
    name: "practice_add",
    description:
      "Save a learning item to the user's Atlas Practice — a spaced-repetition study system. Use for a concept, coding problem, system-design question, frontend question, or flashcard the user is learning or you generate for them. Provide a clear question/prompt and a solution/answer so it can be quizzed and reviewed later. It enters the daily review queue and resurfaces on a spaced schedule.",
    instructions:
      "When the user is learning something, wants to remember a concept, or asks you to generate practice questions/problems (system design, frontend, DSA/coding, etc.), call practice_add with a title, topic, kind, the question, and the solution/answer. Set dueNow:true to study it today.",
    presentation: { label: { pending: "Saving practice item", completed: "Saved practice item" } },
    parameters: z.object({
      title: z.string().describe("Short title of the item."),
      topic: z.string().optional().describe("Topic/area, e.g. 'System Design', 'React', 'DSA'."),
      kind: z.enum(PRACTICE_KINDS as unknown as [string, ...string[]]).optional().describe("concept | coding | system-design | frontend | flashcard | other."),
      question: z.string().optional().describe("The prompt / problem / question (markdown)."),
      solution: z.string().optional().describe("The answer / approach / explanation (markdown)."),
      difficulty: z.enum(["easy", "medium", "hard"]).optional(),
      source: z.string().optional().describe("Where it came from (URL/book)."),
      tags: z.array(z.string()).optional().describe("2-5 lowercase tags."),
      dueNow: z.boolean().optional().describe("Queue it for today (default: enters as new)."),
    }),
    async execute({ title, topic, kind, question, solution, difficulty, source, tags, dueNow }) {
      const row = insertPracticeItem(db, {
        title: title.trim(), topic: topic ?? null, kind: kind ?? "concept",
        question: question ?? null, solution: solution ?? null,
        difficulty: difficulty ?? null, source: source ?? null,
        tags: tags && tags.length ? tags : null, dueNow: dueNow ?? false,
      });
      publishChanged();
      return `Saved practice item #${row.seq} "${row.title}" [${row.kind}] to Atlas Practice.`;
    },
  });

  bb.agents.registerTool({
    name: "practice_due",
    description:
      "Get today's Atlas Practice queue — the items due for review plus a few new ones — so you can run the user's daily ~1-hour learning session. Also returns their standing (streak, counts). Quiz the user one item at a time (show the question, let them answer, then reveal the solution and grade recall with practice_review). Each item includes its solution so you can check answers — don't reveal it until they've tried.",
    instructions:
      "To run the daily practice session or when the user says 'let's practice' / 'quiz me' / 'what should I study', call practice_due, then quiz item by item and grade each with practice_review. Log the session with practice_log_session at the end.",
    presentation: { label: { pending: "Loading practice queue", completed: "Loaded practice queue" } },
    parameters: z.object({ newLimit: z.number().int().optional().describe("Max new items to include (default 10).") }),
    async execute({ newLimit }) {
      const { due, fresh } = dueItems(db, { newLimit: newLimit ?? 10 });
      const s = practiceStats(db);
      const head = `Practice standing — streak ${s.streak}d · due today ${s.dueToday} · new available ${s.newAvailable} · mastered ${s.byStatus.mastered}/${s.total}. Today so far: ${s.todayReviewed} reviewed, ${s.todayMinutes} min.`;
      if (due.length === 0 && fresh.length === 0) {
        return `${head}\n\nNothing in the queue right now — all caught up. Add items with practice_add.`;
      }
      const blocks: string[] = [head];
      if (due.length) blocks.push("", `=== Due for review (${due.length}) ===`, ...due.map((r) => formatPracticeItem(r, { includeSolution: true })));
      if (fresh.length) blocks.push("", `=== New (${fresh.length}) ===`, ...fresh.map((r) => formatPracticeItem(r, { includeSolution: true })));
      blocks.push("", "Quiz one at a time; after each, call practice_review with the id and a grade (again/hard/good/easy).");
      return blocks.join("\n");
    },
  });

  bb.agents.registerTool({
    name: "practice_get",
    description: "Read one Atlas Practice item in full (question, solution, schedule, review history). Use before editing it or to show the user a specific item.",
    instructions: "Call practice_get to read a practice item before editing it.",
    presentation: { label: { pending: "Reading practice item", completed: "Read practice item" } },
    parameters: z.object({ item: z.string().describe("Practice item reference: number, id, or part of its title.") }),
    async execute({ item }) {
      const row = resolvePracticeItem(db, item);
      if (!row) return { content: [{ type: "text", text: `No practice item matching "${item}".` }], isError: true };
      return formatPracticeItem(row, { includeSolution: true });
    },
  });

  bb.agents.registerTool({
    name: "practice_update",
    description: "Edit an Atlas Practice item — its question, solution, topic, kind, difficulty, source, or tags. Read it first with practice_get if you might overwrite content.",
    instructions: "Call practice_update with the item reference and only the fields to change.",
    presentation: { label: { pending: "Updating practice item", completed: "Updated practice item" } },
    parameters: z.object({
      item: z.string().describe("Practice item reference: number, id, or part of its title."),
      title: z.string().optional(),
      topic: z.string().optional(),
      kind: z.enum(PRACTICE_KINDS as unknown as [string, ...string[]]).optional(),
      question: z.string().optional(),
      solution: z.string().optional(),
      difficulty: z.enum(["easy", "medium", "hard"]).optional(),
      source: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    async execute({ item, ...patch }) {
      const row = resolvePracticeItem(db, item);
      if (!row) return { content: [{ type: "text", text: `No practice item matching "${item}".` }], isError: true };
      const updated = updatePracticeItem(db, row.id, patch);
      publishChanged();
      return `Updated practice item #${updated!.seq} "${updated!.title}".`;
    },
  });

  bb.agents.registerTool({
    name: "practice_review",
    description:
      "Record how well the user recalled a practice item and reschedule it (spaced repetition). Grades: 'again' (forgot — resurfaces tomorrow), 'hard', 'good', 'easy' (push further out). Call this after the user attempts an item during a session.",
    instructions: "After quizzing a practice item, call practice_review with its id and the recall grade (again/hard/good/easy).",
    presentation: { label: { pending: "Grading recall", completed: "Graded recall" } },
    parameters: z.object({
      item: z.string().describe("Practice item reference: number, id, or part of its title."),
      grade: z.enum(["again", "hard", "good", "easy"]).describe("How well the user recalled it."),
    }),
    async execute({ item, grade }) {
      const row = resolvePracticeItem(db, item);
      if (!row) return { content: [{ type: "text", text: `No practice item matching "${item}".` }], isError: true };
      const updated = reviewPracticeItem(db, row.id, grade as Grade)!;
      publishChanged();
      const days = Math.round(updated.interval_days);
      return `Graded #${updated.seq} "${updated.title}" (${grade}) → next review in ${days} day${days === 1 ? "" : "s"} · status ${updated.status}.`;
    },
  });

  bb.agents.registerTool({
    name: "practice_log_session",
    description:
      "Log a completed Atlas Practice session — minutes studied, how many items reviewed, and optional notes on what was covered. Keeps the daily streak and weekly stats. Call at the end of a study session (the user's ~1-hour daily practice).",
    instructions: "At the end of a practice session, call practice_log_session with the minutes spent, number of items reviewed, and a short note on what was covered.",
    presentation: { label: { pending: "Logging session", completed: "Logged session" } },
    parameters: z.object({
      minutes: z.number().optional().describe("Minutes spent."),
      reviewed: z.number().optional().describe("Number of items reviewed."),
      notes: z.string().optional().describe("What was covered / how it went."),
    }),
    async execute({ minutes, reviewed, notes }) {
      logSession(db, { minutes, reviewed, notes: notes ?? null });
      const s = practiceStats(db);
      publishChanged();
      return `Logged practice session (${Math.round(minutes ?? 0)} min, ${reviewed ?? 0} reviewed). Streak: ${s.streak} day${s.streak === 1 ? "" : "s"}. 🔥`;
    },
  });

  bb.agents.registerTool({
    name: "practice_from_note",
    description:
      "Turn one of the user's Atlas notes (a saved blog, article, or reading material) into spaced-repetition practice questions. Reads the note and generates N Q&A cards linked back to it, so reading turns into recallable practice. Use when the user says 'make practice from my note on X', 'quiz me on that blog I saved', or after they save reading material they want to remember.",
    instructions:
      "When the user wants to study or be quizzed on something they saved as a note (a blog/article/reading), call practice_from_note with the note reference. It generates linked practice cards. You can also read the note yourself and call practice_add per question for finer control.",
    presentation: { label: { pending: "Generating practice", completed: "Generated practice" } },
    parameters: z.object({
      note: z.string().describe("Note reference: number, id, or part of its title."),
      count: z.number().int().optional().describe("How many questions to generate (default 5, max 20)."),
      dueNow: z.boolean().optional().describe("Queue them for today's session."),
    }),
    async execute({ note, count, dueNow }) {
      const row = resolveNote(db, note);
      if (!row) return { content: [{ type: "text", text: `No note matching "${note}".` }], isError: true };
      const items = await generatePracticeFromNote(row.id, count ?? 5, dueNow ?? false);
      if (items.length === 0) {
        return `Couldn't generate practice from note #${row.seq} "${row.title}" (agent unavailable or the note is empty). Try again shortly.`;
      }
      return `Generated ${items.length} practice card${items.length === 1 ? "" : "s"} from note #${row.seq} "${row.title}", linked back to it:\n${items.map((i) => `- #${i.seq} ${i.title}`).join("\n")}`;
    },
  });

  bb.agents.registerTool({
    name: "practice_grade_attempt",
    description:
      "Record a graded attempt on an Atlas Practice item — the student submitted an answer and you (their teacher) evaluated it. Logs the attempt with your feedback and the weak areas to their learning history, and reschedules the item by the grade (spaced repetition). Use after you evaluate an answer during coaching so Atlas remembers how they did.",
    instructions:
      "When coaching and the user attempts a practice item, evaluate their answer like a teacher, then call practice_grade_attempt with the item, a grade (again/hard/good/easy), concise feedback, and the weak subskills — so it's tracked in their history.",
    presentation: { label: { pending: "Recording attempt", completed: "Recorded attempt" } },
    parameters: z.object({
      item: z.string().describe("Practice item reference: number, id, or part of its title."),
      grade: z.enum(["again", "hard", "good", "easy"]).describe("again=missed, hard=partly right, good=solid, easy=excellent."),
      feedback: z.string().optional().describe("Your teacherly feedback on their answer (markdown)."),
      weakTags: z.array(z.string()).optional().describe("1-4 lowercase subskills/topics they should practise."),
      score: z.number().optional().describe("0-100 estimate."),
      answer: z.string().optional().describe("What the student submitted (for the record)."),
    }),
    async execute({ item, grade, feedback, weakTags, score, answer }) {
      const row = resolvePracticeItem(db, item);
      if (!row) return { content: [{ type: "text", text: `No practice item matching "${item}".` }], isError: true };
      insertAttempt(db, { itemId: row.id, answer: answer ?? null, grade, score: score ?? null, feedback: feedback ?? null, weakTags: weakTags ?? null, mode: "coach" });
      const updated = reviewPracticeItem(db, row.id, grade as Grade)!;
      publishChanged();
      const days = Math.round(updated.interval_days);
      return `Recorded a ${grade} attempt on #${updated.seq} "${updated.title}" (next review in ${days}d)${weakTags && weakTags.length ? ` · noted weak: ${weakTags.join(", ")}` : ""}.`;
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
  bb todo show <id>          full task: notes, comments, subtasks, links
  bb todo comment <id> "<text>"    append a timestamped comment (non-destructive)
  bb todo stage <id> <planned|doing|hold|done>   move it on the board
  bb todo done <id>          mark a task complete
  bb todo undone <id>        reopen a completed task
  bb todo defer <id> --to <date>   move it to a later day
  bb todo edit <id> [--title|--due|--notes|--append-notes|--project ...]
  bb todo rm <id>            delete a task

  bb todo initiative add "<title>" [--status active] [--desc "<text>"] [--tag a,b]
  bb todo initiative list
  bb todo initiative show <ref>
  bb todo initiative status <ref> <idea|active|paused|shipped>
  bb todo initiative update <ref> "<text>" [--status <s>] [--phase <name>]
  bb todo initiative phase <ref> <name>     set/create the active roadmap phase
  bb todo initiative link <ref> <threadId>  link a chat to the initiative
  bb todo initiative rm <ref>

<id> is the short number shown in the list (e.g. 4).
<date> accepts YYYY-MM-DD, today, tomorrow, or +Nd (e.g. +3d).
--project . tags the task with the current thread's project.
Unfinished tasks roll over and keep showing under "today" until done.`;
