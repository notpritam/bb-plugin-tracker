// bb-plugin-tracker — frontend entry.
//
// A "Tracker" sidebar panel: Today / Upcoming / History, an inline add box,
// checkbox toggling, and live refresh when the `bb todo` CLI mutates a task.
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  definePluginApp,
  Markdown,
  ThreadChat,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface ListResult {
  today: string;
  tasks: Task[];
  projects: { id: string; name: string }[];
  allTags: string[];
}

interface Task {
  id: string;
  seq: number;
  title: string;
  status: "open" | "done";
  projectId: string | null;
  projectName: string | null;
  notes: string | null;
  dueDate: string | null;
  createdAt: number;
  doneAt: number | null;
  carriedOver: boolean;
  overdue: boolean;
  tags: string[];
  link: string | null;
  sortOrder: number | null;
  completion: string | null;
  urgent: boolean;
  stage: "planned" | "doing" | "hold" | "done";
  threadIds: string[];
  links: string[];
  subtasks: Subtask[];
  comments: Comment[];
  updatedAt: number;
  activity: { at: number; type: string }[];
  archivedAt: number | null;
  initiativeId: string | null;
  /** UI-only: today's date, stamped client-side for due-date comparisons. */
  __today?: string;
}

interface Subtask {
  id: string;
  text: string;
  done: boolean;
}

interface Comment {
  id: string;
  text: string;
  at: number;
}

type InitiativeStatus = "idea" | "active" | "paused" | "shipped";
type PhaseStatus = "pending" | "active" | "done";

interface InitiativePhase {
  id: string;
  name: string;
  status: PhaseStatus;
}

interface InitiativeUpdate {
  id: string;
  text: string;
  at: number;
  status?: InitiativeStatus | null;
  phaseId?: string | null;
}

interface Initiative {
  id: string;
  seq: number;
  title: string;
  description: string | null;
  status: InitiativeStatus;
  color: string | null;
  tags: string[];
  links: string[];
  updates: InitiativeUpdate[];
  phases: InitiativePhase[];
  createdAt: number;
  updatedAt: number;
  activity: { at: number; type: string }[];
  archivedAt: number | null;
  threadIds: string[];
  taskCount: number;
  doneCount: number;
}

type PracticeStatus = "new" | "learning" | "review" | "mastered";
type PracticeKind = "concept" | "coding" | "system-design" | "frontend" | "flashcard" | "other";
type Grade = "again" | "hard" | "good" | "easy";
interface PracticeItem {
  id: string;
  seq: number;
  title: string;
  topic: string | null;
  kind: string;
  question: string | null;
  solution: string | null;
  difficulty: string | null;
  source: string | null;
  noteId: string | null;
  noteTitle: string | null;
  tags: string[];
  status: PracticeStatus;
  dueAt: number | null;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  lastReviewedAt: number | null;
  reviewLog: { at: number; grade: string; intervalDays: number }[];
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}
interface PracticeStats {
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

/** Relative "3h ago" label (with absolute time on hover via title). */
function relFromNow(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Classify a URL into a typed chip (icon + short label). Labelling is loose —
 *  the point is a URL-first card with recognizable PR / Slack / doc chips. */
function linkKind(url: string): { icon: IconName; label: string } {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const pr = url.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
    if (pr) return { icon: "GitPullRequest", label: `PR #${pr[1]}` };
    const issue = url.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/i);
    if (issue) return { icon: "Github", label: `#${issue[1]}` };
    if (host.includes("github.com")) return { icon: "Github", label: "GitHub" };
    if (host.includes("slack.com")) return { icon: "MessageSquare", label: "Slack" };
    if (host.includes("figma.com")) return { icon: "Palette", label: "Figma" };
    if (host.includes("linear.app")) return { icon: "Layers", label: "Linear" };
    if (host.includes("notion.so") || host.includes("notion.site")) return { icon: "FileText", label: "Notion" };
    if (host.includes("docs.google.com")) return { icon: "FileText", label: "Doc" };
    if (host.includes("loom.com") || host.includes("youtube.com") || host.includes("youtu.be")) return { icon: "Play", label: "Video" };
    return { icon: "ExternalLink", label: host };
  } catch {
    return { icon: "ExternalLink", label: "link" };
  }
}

/** Instant client parse: pull #tags and the first URL out of the add text. */
function clientParse(text: string): { title: string; tags: string[]; link: string | null } {
  let s = ` ${text} `;
  const url = s.match(/https?:\/\/[^\s]+/i)?.[0]?.replace(/[).,]+$/, "") ?? null;
  if (url) s = s.replace(url, " ");
  const tags: string[] = [];
  s = s.replace(/#([\p{L}\p{N}_-]+)/gu, (_m, t: string) => {
    tags.push(t.toLowerCase());
    return " ";
  });
  return { title: s.replace(/\s{2,}/g, " ").trim() || text.trim(), tags, link: url };
}

type View = "today" | "upcoming" | "done";

const VIEWS: { id: View; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "done", label: "History" },
];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Module-level store so panel state survives the plugin unmounting/remounting
 * when the user switches tabs/threads (bb tears the nav panel down on nav).
 * Keyed by a string; lives as long as the JS module is loaded.
 */
const PANEL_STORE = new Map<string, unknown>();
function usePersistentState<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => (PANEL_STORE.has(key) ? (PANEL_STORE.get(key) as T) : initial));
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setV((prev) => {
        const val = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        PANEL_STORE.set(key, val);
        return val;
      });
    },
    [key],
  );
  return [v, set] as const;
}

function TasksView({ tabs }: { tabs: ReactNode }) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<View>("today");
  const [projectFilter, setProjectFilter] = useState<string>(""); // "" = all
  const [tagFilter, setTagFilter] = useState<string>(""); // "" = all
  const [search, setSearch] = useState<string>("");
  const [data, setData] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [smartBusy, setSmartBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    try {
      const res = await rpc.call("listTasks", {
        view,
        projectId: projectFilter || null,
        tag: tagFilter || null,
        search: search || null,
      });
      if (mine === reqId.current) setData(res as ListResult);
    } catch (err) {
      if (mine === reqId.current) toast.error(errorMessage(err));
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, [rpc, view, projectFilter, tagFilter, search]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // The CLI publishes on every mutation — refetch so the panel stays in sync.
  useRealtime("tracker", () => {
    void load();
  });

  const add = useCallback(async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const parsed = clientParse(t);
      await rpc.call("addTask", {
        title: parsed.title,
        tags: parsed.tags,
        link: parsed.link,
        dueDate: due || null,
        projectId: projectFilter || null,
      });
      setTitle("");
      setDue("");
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [rpc, title, due, projectFilter, busy, load]);

  const smartAdd = useCallback(async () => {
    const t = title.trim();
    if (!t || smartBusy) return;
    setSmartBusy(true);
    try {
      const res = (await rpc.call("smartAdd", {
        text: t,
        projectId: projectFilter || null,
      })) as { parsed: { title: string; tags: string[]; dueDate: string | null }; usedAgent: boolean };
      const bits = [
        res.parsed.title,
        res.parsed.tags.map((x) => `#${x}`).join(" "),
        res.parsed.dueDate ? `due ${res.parsed.dueDate}` : "",
      ].filter(Boolean);
      toast.success(`${res.usedAgent ? "✨ " : ""}Added — ${bits.join(" · ")}`);
      setTitle("");
      setDue("");
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSmartBusy(false);
    }
  }, [rpc, title, projectFilter, smartBusy, load]);

  const saveCompletion = useCallback(
    async (task: Task, completion: string) => {
      try {
        await rpc.call("updateTask", { id: task.id, completion: completion || null });
        await load();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [rpc, load],
  );

  const reorder = useCallback(
    async (draggedId: string, targetId: string) => {
      if (draggedId === targetId) return;
      const list = data?.tasks ?? [];
      const targetIdx = list.findIndex((x) => x.id === targetId);
      if (targetIdx < 0) return;
      const above = list[targetIdx - 1];
      // Drop the dragged row directly above the target row.
      const afterId = above && above.id !== draggedId ? above.id : null;
      try {
        await rpc.call("reorder", { id: draggedId, afterId, beforeId: targetId });
        await load();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [rpc, data, load],
  );

  const toggle = useCallback(
    async (task: Task) => {
      try {
        await rpc.call("setStatus", {
          id: task.id,
          status: task.status === "done" ? "open" : "done",
        });
        await load();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [rpc, load],
  );

  const toggleUrgent = useCallback(
    async (task: Task) => {
      try {
        await rpc.call("updateTask", { id: task.id, urgent: !task.urgent });
        await load();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [rpc, load],
  );

  const remove = useCallback(
    async (task: Task) => {
      try {
        await rpc.call("deleteTask", { id: task.id });
        await load();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [rpc, load],
  );

  const projects = data?.projects ?? [];
  const tasks = data?.tasks ?? [];

  return (
    <div className="flex h-full flex-col bg-background">
      {/* One header: tabs + search on top, view pills + tag strip below */}
      <header className="flex flex-col gap-2.5 border-b border-border/60 px-3 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          {tabs}
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Icon
                name="Search"
                className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={search}
                placeholder="Search"
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-32 rounded-lg pl-7 text-xs sm:w-40"
              />
            </div>
            {projects.length > 1 && (
              <select
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="h-8 rounded-lg border border-border/60 bg-card px-2 text-xs text-foreground"
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setView(v.id)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-all",
                  view === v.id
                    ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
          {(data?.allTags ?? []).length > 0 && (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {(data?.allTags ?? []).map((tg) => (
                <TagChip
                  key={tg}
                  label={tg}
                  active={tagFilter === tg}
                  onClick={() => setTagFilter(tagFilter === tg ? "" : tg)}
                />
              ))}
            </div>
          )}
          {(tagFilter || search) && (
            <button
              type="button"
              onClick={() => {
                setTagFilter("");
                setSearch("");
              }}
              className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              clear
            </button>
          )}
        </div>
      </header>

      {/* Command-bar composer — hidden in History */}
      {view !== "done" && (
        <div className="px-3 pt-2.5">
          <div className="flex items-center gap-1.5 rounded-xl border border-border/60 bg-card px-2 py-1.5 shadow-sm transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15">
            <Icon
              name="Plus"
              className="ml-1 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <input
              value={title}
              placeholder="Add a task — #tag, paste a link"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
              }}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
            <input
              type="date"
              value={due}
              title="Due date (optional)"
              onChange={(e) => setDue(e.target.value)}
              className="h-7 w-[7.5rem] shrink-0 rounded-md bg-transparent text-xs text-muted-foreground outline-none"
            />
            <button
              type="button"
              onClick={() => void smartAdd()}
              disabled={!title.trim() || smartBusy}
              aria-label="Smart add — agent assigns title, tags & due date"
              className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              {smartBusy ? (
                <span className="text-sm leading-none">…</span>
              ) : (
                <Icon name="Robot" className="size-4" aria-hidden />
              )}
            </button>
            <button
              type="button"
              onClick={() => void add()}
              disabled={!title.trim() || busy}
              aria-label="Add task"
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Icon name="Plus" className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      )}

      {/* List */}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {loading ? (
          <p className="px-2 py-10 text-center font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Loading
          </p>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-2 py-12 text-center">
            <Icon
              name={view === "done" ? "CircleCheck" : "ListTodo"}
              className="size-6 text-muted-foreground/50"
              aria-hidden
            />
            <p className="text-sm text-muted-foreground">
              {view === "done"
                ? "Nothing completed yet."
                : view === "upcoming"
                  ? "Nothing scheduled ahead."
                  : "All clear — add a task above."}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {tasks.map((task) => (
              <TaskRowView
                key={task.id}
                task={task}
                today={data?.today ?? ""}
                draggable={view !== "done"}
                isDragging={dragId === task.id}
                onDragStart={() => setDragId(task.id)}
                onDragEnd={() => setDragId(null)}
                onDropRow={() => {
                  if (dragId) void reorder(dragId, task.id);
                  setDragId(null);
                }}
                onToggle={() => void toggle(task)}
                onToggleUrgent={() => void toggleUrgent(task)}
                onRemove={() => void remove(task)}
                onTagClick={(tg) => setTagFilter(tagFilter === tg ? "" : tg)}
                onSaveCompletion={(text) => void saveCompletion(task, text)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Compact label for a URL: host (no www) + a short path tail. */
function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.replace(/\/$/, "");
    if (!path) return host;
    const tail = path.length > 16 ? `…${path.slice(-14)}` : path;
    return `${host}${tail}`;
  } catch {
    return u.length > 36 ? `${u.slice(0, 34)}…` : u;
  }
}

function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            target="_blank"
            rel="noreferrer"
            title={p}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex max-w-[240px] items-center gap-1 rounded-md border border-border/60 bg-muted/50 px-1.5 py-0.5 align-middle text-[11px] font-medium text-primary transition-colors hover:border-primary/40 hover:bg-primary/10"
          >
            <Icon name="ExternalLink" className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{shortUrl(p)}</span>
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Pill tag chip — quiet by default, tinted when active. */
function TagChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      <span className="opacity-50">#</span>
      {label}
    </button>
  );
}

/** Uppercase monospace micro-label — the "data face" of the console theme. */
function Meta({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "danger" | "warn";
}) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] uppercase tracking-wider",
        tone === "danger"
          ? "text-destructive"
          : tone === "warn"
            ? "text-amber-500"
            : "text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function TaskRowView({
  task,
  today,
  draggable,
  isDragging,
  onDragStart,
  onDragEnd,
  onDropRow,
  onToggle,
  onToggleUrgent,
  onRemove,
  onTagClick,
  onSaveCompletion,
}: {
  task: Task;
  today: string;
  draggable: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropRow: () => void;
  onToggle: () => void;
  onToggleUrgent: () => void;
  onRemove: () => void;
  onTagClick: (tag: string) => void;
  onSaveCompletion: (text: string) => void;
}) {
  const done = task.status === "done";
  const urgent = task.urgent && !done;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.completion ?? "");
  // Status spine: the signature scannable accent on the left of every row.
  // Urgent overrides everything with a bold amber spine.
  const spine = urgent
    ? "bg-amber-500"
    : done
      ? "bg-transparent"
      : task.overdue
        ? "bg-destructive"
        : task.dueDate === today
          ? "bg-amber-500"
          : task.carriedOver
            ? "bg-muted-foreground/40"
            : "bg-primary/40";
  return (
    <li
      draggable={draggable && !editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (draggable) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropRow();
      }}
      className={cn(
        "tr-row-in group relative flex flex-col rounded-xl py-2 pl-4 pr-2 transition-colors",
        urgent
          ? "bg-amber-500/[0.08] ring-1 ring-inset ring-amber-500/30 hover:bg-amber-500/[0.12]"
          : "hover:bg-muted/40",
        isDragging && "opacity-40",
      )}
    >
      <span
        className={cn(
          "absolute inset-y-2 left-1 rounded-full transition-all",
          urgent ? "tr-urgent-spine w-[3.5px]" : "w-[3px]",
          spine,
        )}
        aria-hidden
      />
      <div className="flex items-start gap-2.5">
        {draggable && (
          <span
            className="mt-0.5 shrink-0 cursor-grab select-none text-muted-foreground/20 transition-colors group-hover:text-muted-foreground/60"
            aria-hidden
            title="Drag to reorder"
          >
            ⠿
          </span>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={done ? "Mark not done" : "Mark done"}
          className={cn(
            "mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-all",
            done
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/40 hover:border-primary hover:ring-2 hover:ring-primary/20",
          )}
        >
          {done && <Icon name="Check" className="size-3" aria-hidden />}
        </button>

        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "flex items-start gap-1.5 text-sm font-medium leading-snug",
              done && "text-muted-foreground line-through",
            )}
          >
            <span className="min-w-0 flex-1">{task.title}</span>
            {task.link && (
              <a
                href={task.link}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={task.link}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Icon name="ExternalLink" className="size-3.5" aria-hidden />
              </a>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {urgent && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-500">
                <Icon name="Zap" className="size-3" aria-hidden />
                urgent
              </span>
            )}
            {task.overdue && task.dueDate && (
              <Meta tone="danger">overdue · {task.dueDate}</Meta>
            )}
            {!task.overdue && task.dueDate && task.dueDate !== today && (
              <Meta tone={task.dueDate === today ? "warn" : "muted"}>
                due {task.dueDate}
              </Meta>
            )}
            {task.carriedOver && <Meta>carried over</Meta>}
            {task.projectName && (
              <Meta>
                <Icon
                  name="Folder"
                  className="mr-0.5 inline size-3 -translate-y-px"
                  aria-hidden
                />
                {task.projectName}
              </Meta>
            )}
            {task.tags.map((tg) => (
              <TagChip key={tg} label={tg} onClick={() => onTagClick(tg)} />
            ))}
            {task.notes && (
              <span className="truncate text-[11px] text-muted-foreground">
                {task.notes}
              </span>
            )}
          </div>
        </div>

        <div className="mt-0.5 flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onToggleUrgent}
            aria-label={urgent ? "Clear urgent" : "Mark urgent"}
            title={urgent ? "Clear urgent" : "Mark urgent"}
            className={cn(
              "grid size-6 place-items-center rounded-md transition-colors",
              urgent
                ? "text-amber-500 hover:bg-amber-500/10"
                : "text-muted-foreground/0 group-hover:text-muted-foreground hover:bg-muted hover:!text-amber-500",
            )}
          >
            <Icon name="Zap" className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(task.completion ?? "");
              setEditing((v) => !v);
            }}
            aria-label="Attach a summary of what was done"
            className={cn(
              "grid size-6 place-items-center rounded-md transition-colors hover:bg-muted hover:text-foreground",
              task.completion
                ? "text-primary/70"
                : "text-muted-foreground/0 group-hover:text-muted-foreground",
            )}
          >
            <Icon name="AlignLeft" className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onRemove}
            aria-label="Delete task"
            className="grid size-6 place-items-center rounded-md text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:bg-destructive/10 hover:!text-destructive"
          >
            <Icon name="Trash2" className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {editing ? (
        <div className="mt-1.5 pl-6">
          <textarea
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                onSaveCompletion(draft.trim());
                setEditing(false);
              }
              if (e.key === "Escape") setEditing(false);
            }}
            placeholder="What did we do? Paste a PR link, session summary…"
            className="min-h-[3.5rem] w-full resize-y rounded-md border border-border bg-background p-2 text-xs text-foreground"
          />
          <div className="mt-1 flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => {
                onSaveCompletion(draft.trim());
                setEditing(false);
              }}
              className="rounded bg-primary px-2 py-0.5 text-primary-foreground"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <span className="ml-auto text-muted-foreground/60">⌘↵ to save</span>
          </div>
        </div>
      ) : task.completion ? (
        <div className="mt-1 whitespace-pre-line pl-6 text-[11px] leading-relaxed text-muted-foreground">
          <Linkified text={task.completion} />
        </div>
      ) : null}
    </li>
  );
}

// ===========================================================================
// Notes
// ===========================================================================

interface Note {
  id: string;
  seq: number;
  title: string;
  body: string;
  tags: string[];
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  threads: { id: string; title: string }[];
  createdAt: number;
  updatedAt: number;
}
interface ThreadRef {
  id: string;
  title: string;
  updatedAt: number;
  projectId: string | null;
}
interface NoteRef {
  id: string;
  seq: number;
  title: string;
}
interface Outlink {
  target: string;
  id: string | null;
  seq: number | null;
}

/**
 * Render a note body as full Markdown (headings, lists, code, tables, bold…),
 * reusing bb's own message renderer. `[[wikilinks]]` are rewritten to links on
 * a `wikilink:` scheme and intercepted on click so they still open that note.
 */
function NoteBody({
  body,
  onOpen,
}: {
  body: string;
  onOpen: (title: string) => void;
}) {
  const md = body.replace(/\[\[([^\]]+)\]\]/g, (_all, inner: string) => {
    const target = inner.split("|")[0]!.trim();
    const label = inner.split("|").pop()!.trim();
    return `[${label}](wikilink:${encodeURIComponent(target)})`;
  });
  const onClick = (e: ReactMouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") ?? "";
    if (href.startsWith("wikilink:")) {
      e.preventDefault();
      e.stopPropagation();
      onOpen(decodeURIComponent(href.slice("wikilink:".length)));
    }
  };
  return (
    <div className="tr-note-md text-sm leading-relaxed text-foreground" onClick={onClick}>
      <Markdown content={md} />
    </div>
  );
}

/**
 * A description field that reads as rendered Markdown and edits as a roomy
 * textarea. Click the rendered view to edit; blur (or Escape) leaves edit mode;
 * saves via onSave only when the text changed.
 */
function MarkdownField({
  value,
  onSave,
  placeholder,
  minRows = 6,
}: {
  value: string;
  onSave: (text: string) => void;
  placeholder: string;
  minRows?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  if (editing) {
    return (
      <textarea
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); if (draft !== value) onSave(draft); }}
        onKeyDown={(e) => { if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
        rows={Math.min(24, Math.max(minRows, draft.split("\n").length + 1))}
        placeholder={placeholder}
        className="w-full resize-y rounded-lg border border-primary/40 bg-card px-3 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60"
      />
    );
  }
  return (
    <div
      onClick={() => setEditing(true)}
      title="Click to edit"
      className="tr-note-md min-h-[5rem] max-h-[22rem] cursor-text overflow-y-auto rounded-lg border border-border/60 bg-card px-3 py-2 text-sm leading-relaxed text-foreground transition-colors hover:border-primary/40"
    >
      {value.trim() ? <Markdown content={value} /> : <span className="text-muted-foreground/50">{placeholder}</span>}
    </div>
  );
}

/** Linked chats for a note: open them, attach more, detach. */
function NoteChats({ note, onSaved }: { note: Note; onSaved: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ThreadRef[]>([]);
  const ids = note.threads.map((t) => t.id);

  const search = useCallback(
    async (query: string) => {
      const r = (await rpc.call("searchThreads", { query, limit: 20 })) as {
        threads: ThreadRef[];
      };
      setResults(r.threads.filter((t) => !ids.includes(t.id)));
    },
    [rpc, ids],
  );
  const attach = async (id: string) => {
    await rpc.call("updateNote", { id: note.id, threadIds: [...ids, id] });
    setOpen(false);
    setQ("");
    onSaved();
  };
  const detach = async (id: string) => {
    await rpc.call("updateNote", {
      id: note.id,
      threadIds: ids.filter((x) => x !== id),
    });
    onSaved();
  };

  return (
    <div className="text-xs">
      <div className="mb-1 flex items-center gap-2 font-medium text-muted-foreground">
        Chats
        <button
          type="button"
          onClick={() => {
            setOpen((o) => !o);
            if (!open) void search("");
          }}
          className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-muted"
        >
          + attach
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {note.threads.length === 0 && (
          <span className="text-muted-foreground">none</span>
        )}
        {note.threads.map((t) => (
          <span
            key={t.id}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5"
          >
            <button
              type="button"
              onClick={() => nav.toThread(t.id)}
              className="text-primary hover:underline"
            >
              💬 {t.title}
            </button>
            <button
              type="button"
              onClick={() => void detach(t.id)}
              className="text-muted-foreground hover:text-destructive"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {open && (
        <div className="mt-2 space-y-1">
          <Input
            value={q}
            placeholder="Search chats…"
            onChange={(e) => {
              setQ(e.target.value);
              void search(e.target.value);
            }}
            className="h-7 text-xs"
          />
          <div className="max-h-40 overflow-auto rounded border border-border">
            {results.length === 0 ? (
              <div className="px-2 py-1 text-muted-foreground">No matches</div>
            ) : (
              results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => void attach(r.id)}
                  className="block w-full truncate px-2 py-1 text-left hover:bg-muted"
                >
                  {r.title}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotesView({
  tabs,
  selectedId,
  onSelect,
}: {
  tabs: ReactNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState("");
  const [search, setSearch] = useState("");
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{
    note: Note;
    backlinks: NoteRef[];
    outlinks: Outlink[];
  } | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftTags, setDraftTags] = useState("");

  const load = useCallback(async () => {
    const res = (await rpc.call("listNotes", {
      tag: tagFilter || null,
      search: search || null,
    })) as { notes: Note[]; allTags: string[] };
    setNotes(res.notes);
    setAllTags(res.allTags);
  }, [rpc, tagFilter, search]);

  const loadDetail = useCallback(
    async (id: string) => {
      const res = (await rpc.call("getNote", { id })) as {
        note: Note;
        backlinks: NoteRef[];
        outlinks: Outlink[];
      };
      setDetail(res);
      setDraftTitle(res.note.title);
      setDraftBody(res.note.body);
      setDraftTags(res.note.tags.join(", "));
    },
    [rpc],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("tracker", () => {
    void load();
    if (selectedId) void loadDetail(selectedId);
  });
  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const add = useCallback(async () => {
    const raw = composer.trim();
    if (!raw || busy) return;
    const [first, ...rest] = raw.split("\n");
    const t = first.trim();
    if (!t) return;
    const b = rest.join("\n").trim();
    setBusy(true);
    try {
      await rpc.call("addNote", { title: t, body: b || null });
      setComposer("");
      toast.success("Note added — tagging…");
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [rpc, composer, busy, load]);

  const openByTitle = useCallback(
    (t: string) => {
      const hit = notes.find(
        (n) => n.title.trim().toLowerCase() === t.trim().toLowerCase(),
      );
      if (hit) onSelect(hit.id);
      else toast.error(`No note titled “${t}”.`);
    },
    [notes, onSelect],
  );

  // ----- detail editor -----
  if (selectedId && detail) {
    const note = detail.note;
    const saveEdit = async () => {
      try {
        await rpc.call("updateNote", {
          id: note.id,
          title: draftTitle.trim() || note.title,
          body: draftBody,
          tags: draftTags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        });
        toast.success("Saved");
        await loadDetail(note.id);
        await load();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    };
    return (
      <div className="flex h-full flex-col overflow-auto">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>
            ← Notes
          </Button>
          <span className="text-xs text-muted-foreground">#{note.seq}</span>
          <div className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                toast.message("Generating practice from this note…");
                try {
                  const r = (await rpc.call("practiceFromNote", { noteId: note.id, count: 5 })) as { count: number };
                  toast.success(r.count ? `🎓 Added ${r.count} practice card${r.count === 1 ? "" : "s"} — find them in Practice` : "No cards generated — try again");
                } catch (e) { toast.error(errorMessage(e)); }
              }}
            >
              🎓 Practice
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const r = (await rpc.call("retagNote", { id: note.id })) as {
                  usedAgent: boolean;
                };
                toast.success(r.usedAgent ? "✨ Retagged" : "Retagged");
                await loadDetail(note.id);
                await load();
              }}
            >
              ✨ Retag
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await rpc.call("deleteNote", { id: note.id });
                onSelect(null);
                await load();
              }}
            >
              Delete
            </Button>
          </div>
        </div>
        <div className="space-y-3 p-4">
          <Input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            className="text-sm font-semibold"
          />
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            rows={8}
            placeholder="Write… use [[Note Title]] to link."
            className="w-full resize-y rounded-md border border-border bg-background p-2 text-sm"
          />
          <Input
            value={draftTags}
            onChange={(e) => setDraftTags(e.target.value)}
            placeholder="tags, comma, separated"
            className="text-xs"
          />
          <div className="flex flex-wrap gap-1">
            {note.tags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                #{t}
              </span>
            ))}
          </div>
          <Button size="sm" onClick={saveEdit}>
            Save
          </Button>

          <div className="rounded-md border border-border p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              Preview
            </div>
            <NoteBody body={draftBody} onOpen={openByTitle} />
          </div>

          {detail.outlinks.length > 0 && (
            <div className="text-xs">
              <div className="mb-1 font-medium text-muted-foreground">
                Links →
              </div>
              <div className="flex flex-wrap gap-1">
                {detail.outlinks.map((o) => (
                  <button
                    key={o.target}
                    type="button"
                    disabled={!o.id}
                    onClick={() => o.id && onSelect(o.id)}
                    className={cn(
                      "rounded border border-border px-1.5 py-0.5",
                      o.id
                        ? "text-foreground hover:bg-muted"
                        : "text-muted-foreground opacity-60",
                    )}
                  >
                    {o.target}
                    {!o.id && " (missing)"}
                  </button>
                ))}
              </div>
            </div>
          )}
          {detail.backlinks.length > 0 && (
            <div className="text-xs">
              <div className="mb-1 font-medium text-muted-foreground">
                Linked from ←
              </div>
              <div className="flex flex-wrap gap-1">
                {detail.backlinks.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => onSelect(b.id)}
                    className="rounded border border-border px-1.5 py-0.5 text-foreground hover:bg-muted"
                  >
                    {b.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          <NoteChats
            note={note}
            onSaved={() => {
              void loadDetail(note.id);
              void load();
            }}
          />
        </div>
      </div>
    );
  }

  // ----- list -----
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex flex-col gap-2.5 border-b border-border/60 px-3 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          {tabs}
          <div className="relative ml-auto">
            <Icon
              name="Search"
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              placeholder="Search"
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-32 rounded-lg pl-7 text-xs sm:w-40"
            />
          </div>
        </div>

        {allTags.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {allTags.map((t) => (
              <TagChip
                key={t}
                label={t}
                active={tagFilter === t}
                onClick={() => setTagFilter(t === tagFilter ? "" : t)}
              />
            ))}
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-2.5">
        {notes.length === 0 ? (
          <div className="mx-auto mt-16 flex max-w-xs flex-col items-center gap-2 text-center">
            <Icon name="FileText" className="size-7 text-muted-foreground/40" aria-hidden />
            <p className="text-sm text-muted-foreground">No notes yet — jot one below.</p>
          </div>
        ) : (
          <div className="[column-gap:10px] [column-width:220px]">
            {notes.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => onSelect(n.id)}
                className="tr-row-in group mb-2.5 flex w-full break-inside-avoid flex-col gap-1.5 rounded-xl border border-border/60 bg-card px-3 py-2.5 text-left align-top transition-all hover:-translate-y-0.5 hover:border-border hover:shadow-md"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{n.title}</span>
                  {n.threads.length > 0 && (
                    <span className="inline-flex shrink-0 items-center gap-0.5">
                      <Icon name="MessageSquare" className="size-3 text-sky-500" aria-hidden />
                      <Meta>{n.threads.length}</Meta>
                    </span>
                  )}
                </div>
                {n.body.trim() && (
                  <div className="line-clamp-4 text-xs leading-relaxed text-muted-foreground">
                    {n.body.replace(/\s+/g, " ").trim()}
                  </div>
                )}
                {n.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {n.tags.slice(0, 4).map((t) => (
                      <span key={t} className="rounded-full border border-border/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">#{t}</span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Fixed bottom composer — like a thread's chat input */}
      <div className="shrink-0 border-t border-border/60 bg-background/80 p-2.5 backdrop-blur">
        <div className="flex items-end gap-2 rounded-xl border border-border/60 bg-card p-1.5 shadow-sm transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15">
          <textarea
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void add(); } }}
            rows={1}
            placeholder="Jot a note…  first line is the title · [[wikilinks]] · ⏎ to save"
            className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            onClick={add}
            disabled={busy || !composer.trim()}
            aria-label="Save note"
            className="mb-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Icon name={busy ? "Loading" : "Sent"} className={cn("size-4", busy && "animate-spin")} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Graph (interactive force-directed, Obsidian style)
// ===========================================================================

type NodeKind = "note" | "task" | "tag" | "thread";
interface GNode {
  id: string;
  kind: NodeKind;
  label: string;
  refId: string;
  degree: number;
}
interface GEdge {
  source: string;
  target: string;
  kind: "link" | "tag" | "thread" | "ref";
}
interface Pos {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}

const KIND_META: Record<
  NodeKind,
  { label: string; fill: string; chip: string }
> = {
  note: { label: "Notes", fill: "fill-primary", chip: "bg-primary" },
  task: { label: "Tasks", fill: "fill-emerald-500", chip: "bg-emerald-500" },
  tag: { label: "Tags", fill: "fill-muted-foreground", chip: "bg-muted-foreground" },
  thread: { label: "Chats", fill: "fill-sky-500", chip: "bg-sky-500" },
};
const KIND_ORDER: NodeKind[] = ["note", "task", "tag", "thread"];

function GraphView({
  tabs,
  onOpenNote,
  onOpenTask,
}: {
  tabs: ReactNode;
  onOpenNote: (noteId: string) => void;
  onOpenTask: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [raw, setRaw] = useState<{ nodes: GNode[]; edges: GEdge[] }>({
    nodes: [],
    edges: [],
  });
  const [enabled, setEnabled] = useState<Record<NodeKind, boolean>>({
    note: true,
    task: true,
    tag: true,
    thread: true,
  });
  const [, forceTick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);

  // Filter the raw graph to the enabled kinds (nodes + edges between them).
  const graph = (() => {
    const nodes = raw.nodes.filter((n) => enabled[n.kind]);
    const keep = new Set(nodes.map((n) => n.id));
    const edges = raw.edges.filter(
      (e) => keep.has(e.source) && keep.has(e.target),
    );
    return { nodes, edges };
  })();

  const svgRef = useRef<SVGSVGElement | null>(null);
  const pos = useRef<Map<string, Pos>>(new Map());
  const view = useRef({ k: 1, x: 0, y: 0 });
  const alpha = useRef(1);
  const drag = useRef<{ id: string | null; panning: boolean; lastX: number; lastY: number }>(
    { id: null, panning: false, lastX: 0, lastY: 0 },
  );
  const raf = useRef<number | null>(null);
  // Feed the persistent rAF loop from refs so it never restarts on re-render.
  const nodesRef = useRef(graph.nodes);
  const edgesRef = useRef(graph.edges);
  nodesRef.current = graph.nodes;
  edgesRef.current = graph.edges;

  const load = useCallback(async () => {
    const g = (await rpc.call("getGraph", {})) as {
      nodes: GNode[];
      edges: GEdge[];
    };
    setRaw(g);
    // Seed positions for new nodes on a ring; keep existing ones.
    const R = 220;
    g.nodes.forEach((n, i) => {
      if (!pos.current.has(n.id)) {
        const a = (i / Math.max(1, g.nodes.length)) * Math.PI * 2;
        pos.current.set(n.id, {
          x: Math.cos(a) * R + (i % 7) * 3,
          y: Math.sin(a) * R + (i % 5) * 3,
          vx: 0,
          vy: 0,
        });
      }
    });
    // Drop positions for removed nodes.
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const key of [...pos.current.keys()])
      if (!ids.has(key)) pos.current.delete(key);
    alpha.current = 1;
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("tracker", () => void load());
  // Reheat when the filter changes so the layout re-settles.
  useEffect(() => {
    alpha.current = Math.max(alpha.current, 0.7);
  }, [enabled]);

  // Force simulation loop — runs once, reads live data from refs.
  useEffect(() => {
    const step = () => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const P = pos.current;
      const a = alpha.current;
      if (nodes.length > 0 && a > 0.005) {
        // Repulsion (O(n^2); fine for a personal graph).
        for (let i = 0; i < nodes.length; i++) {
          const pi = P.get(nodes[i].id);
          if (!pi) continue;
          for (let j = i + 1; j < nodes.length; j++) {
            const pj = P.get(nodes[j].id);
            if (!pj) continue;
            let dx = pi.x - pj.x;
            let dy = pi.y - pj.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) {
              dx = (Math.random() - 0.5) * 0.1;
              dy = (Math.random() - 0.5) * 0.1;
              d2 = 0.01;
            }
            const rep = (2200 * a) / d2;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * rep;
            const fy = (dy / d) * rep;
            pi.vx += fx;
            pi.vy += fy;
            pj.vx -= fx;
            pj.vy -= fy;
          }
        }
        // Springs along edges.
        for (const e of edges) {
          const ps = P.get(e.source);
          const pt = P.get(e.target);
          if (!ps || !pt) continue;
          const dx = pt.x - ps.x;
          const dy = pt.y - ps.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const target = e.kind === "tag" ? 70 : 100;
          const k = 0.04 * a * (d - target);
          const fx = (dx / d) * k;
          const fy = (dy / d) * k;
          ps.vx += fx;
          ps.vy += fy;
          pt.vx -= fx;
          pt.vy -= fy;
        }
        // Centering + integrate.
        for (const n of nodes) {
          const p = P.get(n.id);
          if (!p) continue;
          if (p.fixed) {
            p.vx = 0;
            p.vy = 0;
            continue;
          }
          p.vx += -p.x * 0.005 * a;
          p.vy += -p.y * 0.005 * a;
          p.vx *= 0.85;
          p.vy *= 0.85;
          p.x += p.vx;
          p.y += p.vy;
        }
        alpha.current = Math.max(0, a * 0.992);
      }
      forceTick((t) => (t + 1) & 0xffff);
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, []);

  // ----- interaction -----
  const screenToGraph = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const v = view.current;
    return {
      x: (clientX - rect.left - rect.width / 2 - v.x) / v.k,
      y: (clientY - rect.top - rect.height / 2 - v.y) / v.k,
    };
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const v = view.current;
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left - rect.width / 2;
    const my = e.clientY - rect.top - rect.height / 2;
    const factor = Math.exp(-e.deltaY * 0.001);
    const k = Math.min(4, Math.max(0.2, v.k * factor));
    // Zoom around the cursor.
    v.x = mx - ((mx - v.x) * k) / v.k;
    v.y = my - ((my - v.y) * k) / v.k;
    v.k = k;
    forceTick((t) => (t + 1) & 0xffff);
  };

  const onPointerDown = (e: React.PointerEvent, nodeId?: string) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (nodeId) {
      const p = pos.current.get(nodeId);
      if (p) p.fixed = true;
      drag.current = { id: nodeId, panning: false, lastX: e.clientX, lastY: e.clientY };
      alpha.current = Math.max(alpha.current, 0.5);
    } else {
      drag.current = { id: null, panning: true, lastX: e.clientX, lastY: e.clientY };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d.id) {
      const g = screenToGraph(e.clientX, e.clientY);
      const p = pos.current.get(d.id);
      if (p) {
        p.x = g.x;
        p.y = g.y;
        p.vx = 0;
        p.vy = 0;
      }
      alpha.current = Math.max(alpha.current, 0.3);
    } else if (d.panning) {
      view.current.x += e.clientX - d.lastX;
      view.current.y += e.clientY - d.lastY;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      forceTick((t) => (t + 1) & 0xffff);
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    if (d.id) {
      const p = pos.current.get(d.id);
      if (p) p.fixed = false;
    }
    drag.current = { id: null, panning: false, lastX: 0, lastY: 0 };
  };

  const neighbors = useCallback(
    (id: string) => {
      const set = new Set<string>([id]);
      for (const e of graph.edges) {
        if (e.source === id) set.add(e.target);
        if (e.target === id) set.add(e.source);
      }
      return set;
    },
    [graph.edges],
  );
  const active = hover ? neighbors(hover) : null;
  const v = view.current;

  const openNode = (n: GNode) => {
    if (n.kind === "note") onOpenNote(n.refId);
    else if (n.kind === "thread") nav.toThread(n.refId);
    else if (n.kind === "task") onOpenTask();
  };
  const counts = KIND_ORDER.map(
    (k) => [k, raw.nodes.filter((n) => n.kind === k).length] as const,
  );

  return (
    <div className="flex h-full w-full flex-col">
      {/* One header: mode tabs + filter chips on a single row */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {tabs}
        <div className="flex flex-wrap gap-1">
          {counts.map(([k, count]) => (
            <button
              key={k}
              type="button"
              onClick={() => setEnabled((e) => ({ ...e, [k]: !e[k] }))}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                enabled[k]
                  ? "border-border bg-card text-foreground"
                  : "border-transparent bg-card/40 text-muted-foreground line-through",
              )}
            >
              <span className={cn("h-2 w-2 rounded-full", KIND_META[k].chip)} />
              {KIND_META[k].label} {count}
            </button>
          ))}
        </div>
      </div>
      <div
        className="relative min-h-0 w-full flex-1 overflow-hidden"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--border) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      >
      {/* aurora backdrop — drifting colored light behind the graph */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="tr-blob"
          style={{
            width: 300,
            height: 300,
            left: "10%",
            top: "18%",
            background: "radial-gradient(circle, #7c86e8, transparent 68%)",
            animation: "tr-drift 15s ease-in-out infinite",
          }}
        />
        <div
          className="tr-blob"
          style={{
            width: 260,
            height: 260,
            right: "12%",
            top: "26%",
            background: "radial-gradient(circle, #3fb950, transparent 68%)",
            animation: "tr-drift 19s ease-in-out infinite",
            animationDelay: "-5s",
          }}
        />
        <div
          className="tr-blob"
          style={{
            width: 240,
            height: 240,
            left: "44%",
            bottom: "8%",
            background: "radial-gradient(circle, #38bdf8, transparent 68%)",
            animation: "tr-drift 22s ease-in-out infinite",
            animationDelay: "-9s",
          }}
        />
      </div>
      <div className="absolute bottom-2 left-3 z-10 rounded-md bg-background/70 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground backdrop-blur">
        scroll to zoom · drag bg to pan · drag node to move · double-click to open
      </div>
      <svg
        ref={svgRef}
        className="h-full w-full touch-none"
        style={{ cursor: drag.current.panning ? "grabbing" : "default" }}
        onWheel={onWheel}
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <g
          transform={`translate(${svgRef.current ? svgRef.current.clientWidth / 2 + v.x : 0} ${
            svgRef.current ? svgRef.current.clientHeight / 2 + v.y : 0
          }) scale(${v.k})`}
        >
          {graph.edges.map((e, i) => {
            const ps = pos.current.get(e.source);
            const pt = pos.current.get(e.target);
            if (!ps || !pt) return null;
            const dim = active && !(active.has(e.source) && active.has(e.target));
            const solid = e.kind === "link" || e.kind === "ref";
            return (
              <line
                key={i}
                x1={ps.x}
                y1={ps.y}
                x2={pt.x}
                y2={pt.y}
                className={
                  e.kind === "thread"
                    ? "stroke-sky-500"
                    : e.kind === "tag"
                      ? "stroke-muted-foreground"
                      : "stroke-primary"
                }
                strokeWidth={solid ? 1 : 0.6}
                strokeDasharray={solid ? undefined : "3 3"}
                opacity={dim ? 0.08 : 0.35}
              />
            );
          })}
          {graph.nodes.map((n) => {
            const p = pos.current.get(n.id);
            if (!p) return null;
            const r = n.kind === "tag" ? 4 : 5 + Math.min(10, n.degree * 1.5);
            const dim = active && !active.has(n.id);
            return (
              <g
                key={n.id}
                transform={`translate(${p.x} ${p.y})`}
                opacity={dim ? 0.2 : 1}
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onPointerDown(e, n.id);
                }}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onDoubleClick={() => openNode(n)}
              >
                {hover === n.id && (
                  <circle
                    r={r + 7}
                    className={cn(KIND_META[n.kind].fill, "transition-all")}
                    opacity={0.18}
                  />
                )}
                <circle
                  r={r}
                  className={cn(
                    KIND_META[n.kind].fill,
                    "stroke-background transition-all",
                  )}
                  strokeWidth={1.5}
                />
                {(v.k > 1.1 || hover === n.id) && (
                  <text
                    x={r + 3}
                    y={3}
                    className="fill-foreground"
                    style={{ fontSize: 9, pointerEvents: "none" }}
                  >
                    {n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {raw.nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Nothing yet — add tasks or notes to see the graph.
        </div>
      )}
      </div>
    </div>
  );
}

// ===========================================================================
// Panel shell — Tasks / Notes / Graph
// ===========================================================================

// ===========================================================================
// Library — captures from the browser extension, enriched by the bb agent.
// ===========================================================================

interface Capture {
  id: string;
  type: "screenshot" | "image" | "highlight" | "bookmark" | "note";
  status: "pending" | "processing" | "done" | "failed";
  sourceUrl: string | null;
  sourceTitle: string | null;
  faviconUrl: string | null;
  selectionText: string | null;
  noteText: string | null;
  blobMime: string | null;
  width: number | null;
  height: number | null;
  hasBlob: boolean;
  hasThumb: boolean;
  ocrText: string | null;
  description: string | null;
  summary: string | null;
  category: string | null;
  tags: string[];
  articleText: string | null;
  createdAt: number;
  updatedAt: number;
  enrichedAt: number | null;
}

// The plugin id ("tracker") namespaces its http routes; the frontend <img>
// loads through them so the backend token never reaches the browser.
const CAPTURE_HTTP = "/api/v1/plugins/tracker/http";
const blobUrl = (id: string) => `${CAPTURE_HTTP}/capture-blob?id=${encodeURIComponent(id)}`;
const thumbUrl = (id: string) => `${CAPTURE_HTTP}/capture-thumb?id=${encodeURIComponent(id)}`;

const TYPE_FILTERS: { id: string; label: string; icon: IconName }[] = [
  { id: "", label: "All", icon: "GridView" },
  { id: "screenshot", label: "Shots", icon: "Layers" },
  { id: "highlight", label: "Highlights", icon: "TextWrap" },
  { id: "bookmark", label: "Links", icon: "Globe" },
  { id: "note", label: "Notes", icon: "FileText" },
  { id: "image", label: "Images", icon: "Paperclip" },
];

function typeIcon(t: Capture["type"]): IconName {
  return t === "screenshot"
    ? "Layers"
    : t === "image"
      ? "Paperclip"
      : t === "bookmark"
        ? "Globe"
        : t === "highlight"
          ? "TextWrap"
          : "FileText";
}

function capRelTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function captureTitle(c: Capture): string {
  return (
    c.sourceTitle ||
    c.noteText ||
    c.selectionText ||
    c.sourceUrl ||
    "(untitled)"
  );
}

function StatusBadge({ status }: { status: Capture["status"] }) {
  if (status === "done") return null;
  const map = {
    pending: { icon: "Clock" as IconName, cls: "text-muted-foreground", label: "queued" },
    processing: { icon: "Loading" as IconName, cls: "text-primary animate-spin", label: "enriching" },
    failed: { icon: "AlertTriangle" as IconName, cls: "text-destructive", label: "failed" },
  }[status];
  return (
    <span className="inline-flex items-center gap-1" title={map.label}>
      <Icon name={map.icon} className={cn("h-3 w-3", map.cls)} aria-hidden />
    </span>
  );
}

function CaptureCard({ c, onOpen }: { c: Capture; onOpen: () => void }) {
  const visual = (c.type === "screenshot" || c.type === "image") && c.hasBlob;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="tr-row-in group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card text-left transition-all hover:ring-1 hover:ring-primary/40"
    >
      {visual && (
        <div className="aspect-video overflow-hidden bg-muted/40">
          <img
            src={thumbUrl(c.id)}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
      )}
      <div className="space-y-1.5 p-2.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          <Icon name={typeIcon(c.type)} className="h-3.5 w-3.5" aria-hidden />
          <span>{c.type}</span>
          <StatusBadge status={c.status} />
          <span className="ml-auto normal-case">{capRelTime(c.createdAt)}</span>
        </div>
        <div className="line-clamp-2 text-sm font-medium leading-snug">
          {captureTitle(c)}
        </div>
        {c.summary && (
          <div className="line-clamp-2 text-xs text-muted-foreground">{c.summary}</div>
        )}
        {c.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {c.tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

function CaptureDetail({
  capture,
  onBack,
  onChanged,
}: {
  capture: Capture;
  onBack: () => void;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [c, setC] = useState<Capture>(capture);
  const visual = (c.type === "screenshot" || c.type === "image") && c.hasBlob;

  useEffect(() => {
    let live = true;
    void rpc
      .call("getCapture", { id: capture.id })
      .then((r) => {
        if (live && r.capture) setC(r.capture as Capture);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [rpc, capture.id]);

  const remove = async () => {
    try {
      await rpc.call("deleteCapture", { id: c.id });
      toast.success("Deleted");
      onChanged();
      onBack();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-7 gap-1 px-2">
          <Icon name="ChevronLeft" className="h-4 w-4" aria-hidden />
          Library
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {c.sourceUrl && (
            <a
              href={c.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <Icon name="ExternalLink" className="h-3.5 w-3.5" aria-hidden />
              Source
            </a>
          )}
          <Button variant="ghost" size="sm" onClick={remove} className="h-7 px-2 text-destructive">
            <Icon name="Trash2" className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <Icon name={typeIcon(c.type)} className="h-3.5 w-3.5" aria-hidden />
          <span>{c.type}</span>
          <StatusBadge status={c.status} />
          <span className="ml-auto normal-case">{new Date(c.createdAt).toLocaleString()}</span>
        </div>

        <h2 className="text-base font-semibold leading-snug">{captureTitle(c)}</h2>

        {visual && (
          <img
            src={blobUrl(c.id)}
            alt=""
            className="w-full rounded-lg border border-border/60"
          />
        )}

        {c.selectionText && c.type === "highlight" && (
          <blockquote className="border-l-2 border-primary/50 pl-3 text-sm italic text-foreground/90">
            {c.selectionText}
          </blockquote>
        )}

        {c.noteText && c.type === "note" && (
          <p className="whitespace-pre-wrap text-sm">{c.noteText}</p>
        )}

        {c.summary && (
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Summary</div>
            <p className="text-sm text-foreground/90">{c.summary}</p>
          </div>
        )}

        {(c.category || c.tags.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {c.category && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                {c.category}
              </span>
            )}
            {c.tags.map((t) => (
              <span key={t} className="rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                #{t}
              </span>
            ))}
          </div>
        )}

        {c.type === "bookmark" && c.articleText && (
          <details open>
            <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-muted-foreground">
              Reader
            </summary>
            <div className="mt-2 max-h-[50vh] overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {c.articleText}
            </div>
          </details>
        )}

        {c.ocrText && (
          <details>
            <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-muted-foreground">
              Extracted text (OCR)
            </summary>
            <div className="mt-2 whitespace-pre-wrap text-sm text-foreground/80">{c.ocrText}</div>
          </details>
        )}

        {c.status === "failed" && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Enrichment failed — it will be retried automatically.
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted/50 text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function LibraryView({ tabs }: { tabs: ReactNode }) {
  const rpc = useRpc<typeof rpcContract>();
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [facets, setFacets] = useState<{
    tags: { name: string; count: number }[];
    categories: { name: string; count: number }[];
  }>({ tags: [], categories: [] });
  const [type, setType] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Capture | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await rpc.call("listCaptures", {
        type: type || null,
        tag,
        category,
        q: q || null,
        limit: 60,
      });
      setCaptures(res.captures as Capture[]);
      setConfigured(res.configured);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [rpc, type, tag, category, q]);

  const loadFacets = useCallback(async () => {
    try {
      const f = await rpc.call("captureFacets", {});
      setFacets({ tags: f.tags, categories: f.categories });
    } catch {
      /* ignore */
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadFacets();
  }, [loadFacets]);
  useRealtime("tracker", () => {
    void load();
    void loadFacets();
  });

  if (selected) {
    return (
      <CaptureDetail
        capture={selected}
        onBack={() => setSelected(null)}
        onChanged={() => {
          void load();
          void loadFacets();
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="space-y-2 border-b border-border/60 p-2.5">
        <div className="flex items-center gap-2">
          {tabs}
          <div className="relative ml-auto flex-1">
            <Icon
              name="Search"
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search captures…"
              className="h-8 pl-7 text-sm"
            />
          </div>
        </div>
        {/* type filters */}
        <div className="flex gap-1 overflow-x-auto">
          {TYPE_FILTERS.map((f) => (
            <Chip key={f.id} active={type === f.id} onClick={() => setType(f.id)}>
              <span className="inline-flex items-center gap-1">
                <Icon name={f.icon} className="h-3 w-3" aria-hidden />
                {f.label}
              </span>
            </Chip>
          ))}
        </div>
        {/* category + tag facets */}
        {(facets.categories.length > 0 || facets.tags.length > 0) && (
          <div className="flex flex-wrap gap-1">
            {facets.categories.slice(0, 6).map((cat) => (
              <Chip
                key={`c-${cat.name}`}
                active={category === cat.name}
                onClick={() => setCategory(category === cat.name ? null : cat.name)}
              >
                {cat.name}
              </Chip>
            ))}
            {facets.tags.slice(0, 10).map((t) => (
              <Chip
                key={`t-${t.name}`}
                active={tag === t.name}
                onClick={() => setTag(tag === t.name ? null : t.name)}
              >
                #{t.name}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-auto p-2.5">
        {!configured ? (
          <div className="mx-auto mt-10 max-w-xs space-y-2 text-center text-sm text-muted-foreground">
            <Icon name="Globe" className="mx-auto h-8 w-8 opacity-40" aria-hidden />
            <p className="font-medium text-foreground">Connect your Atlas backend</p>
            <p>
              Set the backend URL and device token in this plugin's settings, then
              reload. Captures from the browser extension will appear here.
            </p>
          </div>
        ) : captures.length === 0 ? (
          <div className="mx-auto mt-10 max-w-xs space-y-2 text-center text-sm text-muted-foreground">
            <Icon name="Layers" className="mx-auto h-8 w-8 opacity-40" aria-hidden />
            <p className="font-medium text-foreground">
              {loading ? "Loading…" : "Nothing here yet"}
            </p>
            {!loading && (
              <p>Capture a screenshot, highlight, link or note from the browser extension.</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {captures.map((c) => (
              <CaptureCard key={c.id} c={c} onOpen={() => setSelected(c)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Kanban board — tasks as Planned / In Progress / Done columns with drag-drop.
// ===========================================================================

type Stage = "planned" | "doing" | "hold" | "done";

const COLUMNS: { id: Stage; label: string; icon: IconName; tint: string; ring: string }[] = [
  { id: "planned", label: "Planned", icon: "Target", tint: "text-muted-foreground", ring: "ring-border" },
  { id: "doing", label: "In Progress", icon: "Loading", tint: "text-amber-500", ring: "ring-amber-500/30" },
  { id: "hold", label: "On Hold", icon: "Pause", tint: "text-violet-400", ring: "ring-violet-400/30" },
  { id: "done", label: "Done", icon: "CircleCheck", tint: "text-emerald-500", ring: "ring-emerald-500/30" },
];

const STAGE_FILL: Record<Stage, number> = { planned: 0, doing: 0.5, hold: 0.5, done: 1 };

const INITIATIVE_COLUMNS: { id: InitiativeStatus; label: string; icon: IconName; tint: string }[] = [
  { id: "idea", label: "Idea", icon: "Zap", tint: "text-amber-400" },
  { id: "active", label: "Active", icon: "Play", tint: "text-emerald-500" },
  { id: "paused", label: "Paused", icon: "Pause", tint: "text-violet-400" },
  { id: "shipped", label: "Shipped", icon: "CircleCheck", tint: "text-sky-500" },
];
function initiativeCol(status: InitiativeStatus) {
  return INITIATIVE_COLUMNS.find((c) => c.id === status) ?? INITIATIVE_COLUMNS[0];
}

const PHASE_META: Record<PhaseStatus, { icon: IconName; tint: string; label: string }> = {
  pending: { icon: "Circle", tint: "text-muted-foreground/50", label: "Pending" },
  active: { icon: "Play", tint: "text-amber-500", label: "Active" },
  done: { icon: "CircleCheck", tint: "text-emerald-500", label: "Done" },
};
const NEXT_PHASE_STATUS: Record<PhaseStatus, PhaseStatus> = {
  pending: "active",
  active: "done",
  done: "pending",
};
const DEFAULT_PHASE_TEMPLATE = ["Discovery", "Design", "Build", "Launch"];
function newPhaseId(salt: number | string = "") {
  return `ph_${Date.now().toString(36)}${salt}${Math.random().toString(36).slice(2, 5)}`;
}

const PRACTICE_KIND_META: Record<string, { icon: IconName; tint: string; label: string }> = {
  concept: { icon: "Brain", tint: "text-violet-400", label: "Concept" },
  coding: { icon: "Code", tint: "text-emerald-500", label: "Coding" },
  "system-design": { icon: "Layers", tint: "text-sky-500", label: "System Design" },
  frontend: { icon: "Globe", tint: "text-amber-500", label: "Frontend" },
  flashcard: { icon: "FileQuestion", tint: "text-pink-400", label: "Flashcard" },
  other: { icon: "FileText", tint: "text-muted-foreground", label: "Other" },
};
const PRACTICE_KINDS: PracticeKind[] = ["concept", "coding", "system-design", "frontend", "flashcard", "other"];
function practiceKindMeta(kind: string) {
  return PRACTICE_KIND_META[kind] ?? PRACTICE_KIND_META.other!;
}
const PRACTICE_STATUS_TINT: Record<PracticeStatus, string> = {
  new: "text-muted-foreground",
  learning: "text-amber-500",
  review: "text-sky-500",
  mastered: "text-emerald-500",
};
const GRADE_META: { id: Grade; label: string; cls: string; hint: string }[] = [
  { id: "again", label: "Again", cls: "bg-rose-500/15 text-rose-500 hover:bg-rose-500/25", hint: "forgot" },
  { id: "hard", label: "Hard", cls: "bg-amber-500/15 text-amber-500 hover:bg-amber-500/25", hint: "" },
  { id: "good", label: "Good", cls: "bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25", hint: "" },
  { id: "easy", label: "Easy", cls: "bg-sky-500/15 text-sky-500 hover:bg-sky-500/25", hint: "" },
];
/** "due in 3d" / "due now" / "2h" label from a dueAt ms (practice items). */
function practiceDueLabel(dueAt: number | null): string {
  if (dueAt == null) return "new";
  const diff = dueAt - Date.now();
  if (diff <= 0) return "due now";
  const days = Math.round(diff / 86400000);
  if (days >= 1) return `in ${days}d`;
  const hrs = Math.max(1, Math.round(diff / 3600000));
  return `in ${hrs}h`;
}

/** A tiny progress ring — stage-driven, or subtask-driven when subtasks exist. */
function StageRing({ fill, colorClass, label }: { fill: number; colorClass: string; label?: string }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <span className="inline-flex items-center gap-1">
      <svg width="18" height="18" viewBox="0 0 18 18" className={colorClass} aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
        {fill > 0 && (
          <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - fill)} transform="rotate(-90 9 9)" />
        )}
      </svg>
      <span className={cn("text-[11px] font-medium tabular-nums", colorClass)}>{label ?? `${Math.round(fill * 100)}%`}</span>
    </span>
  );
}

/** Subtask-aware ring props for a task card/row. */
function ringFor(task: Task): { fill: number; colorClass: string; label?: string } {
  const total = task.subtasks.length;
  const doneN = task.subtasks.filter((s) => s.done).length;
  const fill = task.stage === "done" ? 1 : total ? doneN / total : STAGE_FILL[task.stage];
  const colorClass =
    task.stage === "done"
      ? "text-emerald-500"
      : task.stage === "hold"
        ? "text-violet-400"
        : task.stage === "doing" || (total > 0 && doneN > 0)
          ? "text-amber-500"
          : "text-muted-foreground/50";
  return { fill, colorClass, label: total ? `${doneN}/${total}` : undefined };
}

function dueLabel(dueDate: string): string {
  const dt = new Date(`${dueDate}T12:00:00`);
  return dt.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function KanbanCard({
  task,
  onOpen,
  onOpenComplete,
  onUrgent,
  onDelete,
  onArchive,
  onAddLink,
  onDragStart,
  onDragEnd,
  onDropBefore,
  dragging,
}: {
  task: Task;
  onOpen: () => void;
  onOpenComplete: () => void;
  onUrgent: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onAddLink: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropBefore: () => void;
  dragging: boolean;
}) {
  const [over, setOver] = useState(false);
  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); onDropBefore(); }}
      onClick={(e) => { if ((e.target as HTMLElement).closest("button,a,input")) return; onOpen(); }}
      className={cn(
        "group tr-row-in cursor-grab rounded-xl border bg-card p-3 shadow-sm ring-1 ring-transparent transition-all active:cursor-grabbing",
        "hover:-translate-y-0.5 hover:shadow-md",
        task.urgent ? "border-amber-500/40" : "border-border/70",
        over && "ring-2 ring-primary/50",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onOpenComplete}
          title={task.status === "done" ? "Reopen" : "Mark done"}
          className={cn(
            "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
            task.status === "done"
              ? "border-emerald-500 bg-emerald-500 text-white"
              : "border-border hover:border-primary",
          )}
        >
          {task.status === "done" && <Icon name="Check" className="size-2.5" aria-hidden />}
        </button>
        <h4 className={cn("min-w-0 flex-1 text-sm font-medium leading-snug tracking-tight", task.status === "done" && "text-muted-foreground line-through")}>
          {task.title}
        </h4>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button type="button" onClick={onAddLink} title="Attach a link (PR, Slack, doc…)" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <Icon name="Paperclip" className="size-3.5" aria-hidden />
          </button>
          <button type="button" onClick={onUrgent} title="Urgent" className={cn("grid size-6 place-items-center rounded-md hover:bg-muted", task.urgent ? "text-amber-500" : "text-muted-foreground")}>
            <Icon name="Zap" className="size-3.5" aria-hidden />
          </button>
          <button type="button" onClick={onArchive} title="Archive" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <Icon name="Archive" className="size-3.5" aria-hidden />
          </button>
          <button type="button" onClick={onDelete} title="Delete" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
            <Icon name="Trash2" className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {task.notes && (
        <p className="mt-1.5 line-clamp-2 pl-6 text-xs leading-relaxed text-muted-foreground">{task.notes}</p>
      )}

      {task.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 pl-6">
          {task.tags.slice(0, 4).map((t) => (
            <span key={t} className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">#{t}</span>
          ))}
        </div>
      )}

      {task.links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 pl-6">
          {task.links.map((url, i) => {
            const k = linkKind(url);
            return (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={url}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
              >
                <Icon name={k.icon} className="size-3" aria-hidden />
                <span className="max-w-[130px] truncate">{k.label}</span>
              </a>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between pl-6">
        <div className="flex items-center gap-1.5">
          {task.dueDate ? (
            <span className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
              task.overdue ? "bg-destructive/10 text-destructive" : task.dueDate === task.__today ? "bg-amber-500/10 text-amber-600 dark:text-amber-500" : "text-muted-foreground",
            )}>
              <Icon name="Calendar" className="size-3" aria-hidden />
              {dueLabel(task.dueDate)}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground/60">No date</span>
          )}
          {task.projectName && (
            <span className="truncate rounded-md bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">{task.projectName}</span>
          )}
          {task.comments.length > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground" title={`${task.comments.length} comment${task.comments.length > 1 ? "s" : ""}`}>
              <Icon name="MessageSquare" className="size-3" aria-hidden />
              {task.comments.length}
            </span>
          )}
        </div>
        <StageRing {...ringFor(task)} />
      </div>
    </article>
  );
}

/**
 * Reusable "Linked chats" section (many-to-many): list linked chats, open them,
 * link more via a thread search, unlink. Wired by callbacks so both tasks and
 * initiatives can share it.
 */
function LinkedChats({
  threadIds,
  fetchRefs,
  onLink,
  onUnlink,
}: {
  threadIds: string[];
  fetchRefs: () => Promise<ThreadRef[]>;
  onLink: (id: string) => Promise<void>;
  onUnlink: (id: string) => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [refs, setRefs] = useState<ThreadRef[]>([]);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ThreadRef[]>([]);
  const key = threadIds.join(",");

  const loadRefs = useCallback(async () => {
    if (threadIds.length === 0) { setRefs([]); return; }
    try { setRefs(await fetchRefs()); } catch { /* thread gone — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { void loadRefs(); }, [loadRefs]);

  const search = useCallback(async (query: string) => {
    try {
      const r = (await rpc.call("searchThreads", { query, limit: 20 })) as { threads: ThreadRef[] };
      setResults(r.threads.filter((t) => !threadIds.includes(t.id)));
    } catch { setResults([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, key]);

  const link = async (id: string) => {
    try { await onLink(id); setAdding(false); setQ(""); await loadRefs(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const unlink = async (id: string) => {
    try { await onUnlink(id); setRefs((rs) => rs.filter((r) => r.id !== id)); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Linked chats</span>
        {refs.length > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{refs.length}</span>}
        <button
          type="button"
          onClick={() => { setAdding((o) => !o); if (!adding) void search(""); }}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Icon name="Plus" className="size-3" aria-hidden /> Link a chat
        </button>
      </div>
      {refs.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {refs.map((t) => (
            <div key={t.id} className="group/th flex items-center gap-2 rounded-lg border border-border/50 bg-card px-2.5 py-1.5">
              <Icon name="MessageSquare" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <button type="button" onClick={() => nav.toThread(t.id)} className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:text-primary hover:underline" title={t.title}>
                {t.title}
              </button>
              <button type="button" onClick={() => void unlink(t.id)} aria-label="Unlink chat" className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/th:opacity-100">
                <Icon name="X" className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
      {adding && (
        <div className="rounded-lg border border-border/60 bg-card p-1.5">
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); void search(e.target.value); }}
            autoFocus
            placeholder="Search chats to link…"
            className="w-full bg-transparent px-1.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          <div className="mt-1 max-h-44 space-y-0.5 overflow-y-auto">
            {results.length === 0 ? (
              <p className="px-1.5 py-1 text-xs text-muted-foreground">No chats found.</p>
            ) : (
              results.map((t) => (
                <button key={t.id} type="button" onClick={() => void link(t.id)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted">
                  <Icon name="MessageSquare" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Linked chats for a task. */
function TaskThreads({ taskId, threadIds }: { taskId: string; threadIds: string[] }) {
  const rpc = useRpc<typeof rpcContract>();
  return (
    <LinkedChats
      threadIds={threadIds}
      fetchRefs={async () => ((await rpc.call("taskThreadRefs", { taskId })) as { threads: ThreadRef[] }).threads}
      onLink={async (id) => { await rpc.call("linkTaskThread", { taskId, threadId: id }); }}
      onUnlink={async (id) => { await rpc.call("unlinkTaskThread", { taskId, threadId: id }); }}
    />
  );
}

function TaskDetail({
  task,
  projects,
  onClose,
}: {
  task: Task;
  projects: { id: string; name: string }[];
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [due, setDue] = useState(task.dueDate ?? "");
  const [projectId, setProjectId] = useState(task.projectId ?? "");
  const [urgent, setUrgent] = useState(task.urgent);
  const [stage, setStage] = useState<Stage>(task.stage);
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks);
  const [links, setLinks] = useState<string[]>(task.links);
  const [tags, setTags] = useState<string[]>(task.tags);
  const [comments, setComments] = useState<Comment[]>(task.comments);
  const [subInput, setSubInput] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [cmInput, setCmInput] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [askInput, setAskInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [width, setWidth] = useState(() => {
    const v = Number(typeof localStorage !== "undefined" ? localStorage.getItem("atlas-drawer-w") : 0);
    return v >= 320 && v <= 760 ? v : 420;
  });
  useEffect(() => {
    try {
      localStorage.setItem("atlas-drawer-w", String(width));
    } catch {
      /* storage unavailable — fine */
    }
  }, [width]);
  const onResizeStart = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: MouseEvent) => setWidth(Math.min(760, Math.max(320, startW + (startX - ev.clientX))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const patch = useCallback(
    (p: Record<string, unknown>) =>
      rpc.call("updateTask", { id: task.id, ...p }).catch((e) => toast.error(errorMessage(e))),
    [rpc, task.id],
  );
  const changeStage = (s: Stage) => {
    setStage(s);
    rpc.call("setStage", { id: task.id, stage: s }).catch((e) => toast.error(errorMessage(e)));
  };
  const copyRef = async () => {
    const ref = `Tracker task #${task.seq}: "${task.title}" (id: ${task.id})`;
    try {
      await navigator.clipboard.writeText(ref);
      toast.success(`Copied task #${task.seq} — paste it in a thread`);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = ref;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast.success(`Copied task #${task.seq}`);
      } catch {
        toast.error("Couldn't copy");
      }
      ta.remove();
    }
  };
  const saveSubs = (next: Subtask[]) => { setSubtasks(next); patch({ subtasks: next }); };
  const addSub = () => {
    const t = subInput.trim();
    if (!t) return;
    saveSubs([...subtasks, { id: `st_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: t, done: false }]);
    setSubInput("");
  };
  const addLink = () => {
    let u = linkInput.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    const next = [...new Set([...links, u])];
    setLinks(next); patch({ links: next, link: null }); setLinkInput("");
  };
  const delLink = (u: string) => { const next = links.filter((x) => x !== u); setLinks(next); patch({ links: next, link: null }); };
  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, "").toLowerCase();
    if (!t) return;
    const next = [...new Set([...tags, t])];
    setTags(next); patch({ tags: next }); setTagInput("");
  };
  const delTag = (t: string) => { const next = tags.filter((x) => x !== t); setTags(next); patch({ tags: next }); };
  const ask = async () => {
    const msg = askInput.trim();
    if (!msg || asking) return;
    setAsking(true);
    try {
      const r = (await rpc.call("askAgentAboutTask", { taskId: task.id, message: msg })) as { threadId: string };
      setAskInput("");
      setAskOpen(false);
      toast.success("Started an agent on this task — opening the chat…");
      nav.toThread(r.threadId);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAsking(false);
    }
  };
  const saveComments = (next: Comment[]) => { setComments(next); patch({ comments: next }); };
  const addComment = () => {
    const t = cmInput.trim();
    if (!t) return;
    saveComments([...comments, { id: `cm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: t, at: Date.now() }]);
    setCmInput("");
  };
  const doneN = subtasks.filter((s) => s.done).length;

  return (
    <div className="absolute inset-0 z-30">
      <button
        className="tr-scrim absolute inset-0 h-full w-full cursor-default bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close"
      />
      <aside
        style={{ width: `${width}px`, maxWidth: "94%" }}
        className="tr-drawer absolute right-0 top-0 flex h-full flex-col border-l border-border bg-background shadow-2xl backdrop-blur-2xl"
      >
        <div
          onMouseDown={onResizeStart}
          title="Drag to resize"
          className="group/resize absolute inset-y-0 left-0 z-20 flex w-2 -translate-x-1/2 cursor-col-resize items-stretch justify-center"
        >
          <span className="w-px bg-transparent transition-colors group-hover/resize:w-0.5 group-hover/resize:bg-primary/60" />
        </div>
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
            {COLUMNS.map((c) => (
              <button key={c.id} type="button" onClick={() => changeStage(c.id)}
                className={cn("inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-all",
                  stage === c.id ? cn("bg-background shadow-sm ring-1 ring-border/60", c.tint) : "text-muted-foreground hover:text-foreground")}>
                <Icon name={c.icon} className={cn("size-3.5", c.id === "doing" && stage === c.id && "animate-spin")} aria-hidden />
                {c.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setAskOpen((o) => !o)}
              title="Ask the agent to act on this task — change, add context, link a chat, update, edit…"
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                askOpen ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-primary/10 hover:text-primary",
              )}
            >
              <Icon name="Robot" className="size-4" aria-hidden />
              Ask agent
            </button>
            <button type="button" onClick={copyRef} title="Copy task reference — paste in a thread / ask your agent to act on it" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <Icon name="Copy" className="size-4" aria-hidden />
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <Icon name="X" className="size-4" aria-hidden />
            </button>
          </div>
        </div>

        {askOpen && (
          <div className="border-b border-border/60 bg-primary/5 px-4 py-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-primary">
              <Icon name="Robot" className="size-3.5" aria-hidden />
              Ask the agent to act on this task
            </div>
            <div className="flex items-end gap-2 rounded-lg border border-primary/30 bg-card p-1.5 focus-within:border-primary/60">
              <textarea
                value={askInput}
                onChange={(e) => setAskInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); } }}
                rows={2}
                autoFocus
                disabled={asking}
                placeholder="e.g. “add context from PR #5307”, “link the CutRoom chat”, “move to QA and set due Friday”, “break into subtasks”…  ⏎ to send"
                className="max-h-32 min-h-[40px] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
              />
              <button
                type="button"
                onClick={() => void ask()}
                disabled={!askInput.trim() || asking}
                aria-label="Send to agent"
                className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <Icon name={asking ? "Loading" : "Sent"} className={cn("size-4", asking && "animate-spin")} aria-hidden />
              </button>
            </div>
            <p className="mt-1 text-[10.5px] text-muted-foreground">Opens a new chat linked to this task; the agent uses the Atlas tools to make the changes.</p>
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <textarea value={title} onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { const t = title.trim(); if (t && t !== task.title) patch({ title: t }); }}
            rows={1} placeholder="Task title"
            className="w-full resize-none border-0 bg-transparent p-0 text-lg font-semibold leading-snug tracking-tight text-foreground outline-none placeholder:text-muted-foreground" />

          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card px-2.5 py-1.5 text-xs">
              <Icon name="Calendar" className="size-3.5 text-muted-foreground" aria-hidden />
              <input type="date" value={due} onChange={(e) => { setDue(e.target.value); patch({ dueDate: e.target.value || null }); }} className="bg-transparent text-foreground outline-none" />
            </label>
            <button type="button" onClick={() => { const nv = !urgent; setUrgent(nv); patch({ urgent: nv }); }}
              className={cn("inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium",
                urgent ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-500" : "border-border/60 bg-card text-muted-foreground hover:text-foreground")}>
              <Icon name="Zap" className="size-3.5" aria-hidden /> Urgent
            </button>
            {projects.length > 1 && (
              <select value={projectId} onChange={(e) => { setProjectId(e.target.value); patch({ projectId: e.target.value || null }); }}
                className="rounded-lg border border-border/60 bg-card px-2 py-1.5 text-xs text-foreground">
                <option value="">No project</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
          </div>

          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Description</div>
            <MarkdownField
              value={notes}
              placeholder="Add details…  (Markdown supported)"
              onSave={(t) => { setNotes(t); patch({ notes: t || null }); }}
            />
          </section>

          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Subtasks</span>
              {subtasks.length > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{doneN}/{subtasks.length}</span>}
            </div>
            {subtasks.length > 0 && (
              <div className="mb-2 h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(doneN / subtasks.length) * 100}%` }} />
              </div>
            )}
            <div className="space-y-0.5">
              {subtasks.map((s) => (
                <div key={s.id} className="group/sub flex items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/50">
                  <button type="button" onClick={() => saveSubs(subtasks.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)))}
                    className={cn("grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors", s.done ? "border-primary bg-primary text-primary-foreground" : "border-border hover:border-primary")}>
                    {s.done && <Icon name="Check" className="size-2.5" aria-hidden />}
                  </button>
                  <span className={cn("min-w-0 flex-1 text-sm", s.done && "text-muted-foreground line-through")}>{s.text}</span>
                  <button type="button" onClick={() => saveSubs(subtasks.filter((x) => x.id !== s.id))}
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/sub:opacity-100">
                    <Icon name="X" className="size-3.5" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex items-center gap-2 pl-1">
              <Icon name="Plus" className="size-3.5 text-muted-foreground" aria-hidden />
              <input value={subInput} onChange={(e) => setSubInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addSub(); }}
                placeholder="Add a subtask…" className="flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" />
            </div>
          </section>

          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Links</div>
            {links.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {links.map((url) => {
                  const k = linkKind(url);
                  return (
                    <span key={url} className="group/link inline-flex items-center gap-1 rounded-md border border-border/60 bg-card px-2 py-1 text-xs text-muted-foreground">
                      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                        <Icon name={k.icon} className="size-3" aria-hidden />
                        <span className="max-w-[160px] truncate">{k.label}</span>
                      </a>
                      <button type="button" onClick={() => delLink(url)} className="opacity-0 transition-opacity hover:text-destructive group-hover/link:opacity-100">
                        <Icon name="X" className="size-3" aria-hidden />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card px-2.5 py-1.5">
              <Icon name="Paperclip" className="size-3.5 text-muted-foreground" aria-hidden />
              <input value={linkInput} onChange={(e) => setLinkInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addLink(); }}
                placeholder="Paste a PR, Slack, doc or URL…" className="flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" />
            </div>
          </section>

          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tags</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map((t) => (
                <span key={t} className="group/tag inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
                  #{t}
                  <button type="button" onClick={() => delTag(t)} className="opacity-0 transition-opacity hover:text-destructive group-hover/tag:opacity-100">
                    <Icon name="X" className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
              <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addTag(); }}
                placeholder="add tag" className="w-24 border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground" />
            </div>
          </section>

          <TaskThreads taskId={task.id} threadIds={task.threadIds} />

          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Comments</span>
              {comments.length > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{comments.length}</span>}
            </div>
            {comments.length > 0 && (
              <div className="mb-2 space-y-2">
                {comments.map((c) => {
                  const isAgent = c.text.startsWith("🤖");
                  return (
                    <div key={c.id} className={cn("group/cm rounded-lg border px-3 py-2", isAgent ? "border-primary/30 bg-primary/5" : "border-border/50 bg-card")}>
                      <div className="mb-1 flex items-center gap-2">
                        <Icon name={isAgent ? "Robot" : "MessageSquare"} className={cn("size-3", isAgent ? "text-primary" : "text-muted-foreground")} aria-hidden />
                        {isAgent && <span className="text-[10.5px] font-medium text-primary">Atlas</span>}
                        <span className="text-[10.5px] text-muted-foreground" title={new Date(c.at).toLocaleString()}>{relFromNow(c.at)}</span>
                        <button type="button" onClick={() => saveComments(comments.filter((x) => x.id !== c.id))} className="ml-auto text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/cm:opacity-100">
                          <Icon name="X" className="size-3" aria-hidden />
                        </button>
                      </div>
                      <p className="whitespace-pre-wrap text-sm text-foreground">{isAgent ? c.text.replace(/^🤖\s*/, "") : c.text}</p>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-end gap-2 rounded-lg border border-border/60 bg-card p-1.5 transition focus-within:border-primary/40">
              <textarea
                value={cmInput}
                onChange={(e) => setCmInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addComment(); } }}
                rows={1}
                placeholder="Add a comment to track progress…  ⏎ to post"
                className="max-h-28 min-h-[32px] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
              />
              <button type="button" onClick={addComment} disabled={!cmInput.trim()} aria-label="Add comment" className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40">
                <Icon name="Sent" className="size-3.5" aria-hidden />
              </button>
            </div>
          </section>
        </div>

        <div className="flex items-center justify-between border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="font-mono">#{task.seq}</span>
            <span title={new Date(task.createdAt).toLocaleString()}>· added {new Date(task.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
            {task.updatedAt > task.createdAt && (
              <span title={new Date(task.updatedAt).toLocaleString()}>· edited {relFromNow(task.updatedAt)}</span>
            )}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                const archiving = task.archivedAt == null;
                rpc.call("archiveTask", { id: task.id, archived: archiving })
                  .then(() => { if (archiving) onClose(); })
                  .catch((e) => toast.error(errorMessage(e)));
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-muted hover:text-foreground"
            >
              <Icon name={task.archivedAt ? "ArchiveRestore" : "Archive"} className="size-3.5" aria-hidden />
              {task.archivedAt ? "Unarchive" : "Archive"}
            </button>
            <button type="button" onClick={() => rpc.call("deleteTask", { id: task.id }).then(onClose).catch((e) => toast.error(errorMessage(e)))}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-destructive/10 hover:text-destructive">
              <Icon name="Trash2" className="size-3.5" aria-hidden /> Delete
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function KanbanView({ tabs, openTaskId }: { tabs: ReactNode; openTaskId?: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState<Task[]>([]);
  const [done, setDone] = useState<Task[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [search, setSearch] = useState("");
  const [today, setToday] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [smartBusy, setSmartBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<Stage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [archivedList, setArchivedList] = useState<Task[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    try {
      const [openRes, doneRes, archRes] = await Promise.all([
        rpc.call("listTasks", { view: "all", projectId: projectFilter || null, search: search || null }),
        rpc.call("listTasks", { view: "done", projectId: projectFilter || null, search: search || null }),
        rpc.call("listTasks", { view: "archived", projectId: projectFilter || null, search: search || null }),
      ]);
      if (mine !== reqId.current) return;
      const stamp = (t: Task): Task => ({ ...t, __today: (openRes as ListResult).today });
      setToday((openRes as ListResult).today);
      setOpen((openRes as ListResult).tasks.map(stamp));
      setDone((doneRes as ListResult).tasks.map(stamp));
      setArchivedList((archRes as ListResult).tasks.map(stamp));
      setProjects((openRes as ListResult).projects);
    } catch (err) {
      if (mine === reqId.current) toast.error(errorMessage(err));
    }
  }, [rpc, projectFilter, search]);

  useEffect(() => { void load(); }, [load]);
  useRealtime("tracker", () => void load());

  const columns: Record<Stage, Task[]> = {
    planned: open.filter((t) => t.stage === "planned"),
    doing: open.filter((t) => t.stage === "doing"),
    hold: open.filter((t) => t.stage === "hold"),
    done,
  };
  const selectedTask = [...open, ...done, ...archivedList].find((t) => t.id === selectedId) ?? null;
  useEffect(() => {
    if (selectedId && !selectedTask) setSelectedId(null);
  }, [selectedId, selectedTask]);
  // Deep link from a thread panel: open that task's drawer.
  useEffect(() => {
    if (openTaskId) setSelectedId(openTaskId);
  }, [openTaskId]);

  const add = useCallback(async (smart: boolean) => {
    const t = title.trim();
    if (!t) return;
    if (smart) setSmartBusy(true); else setBusy(true);
    try {
      if (smart) {
        await rpc.call("smartAdd", { text: t, projectId: projectFilter || null });
      } else {
        const p = clientParse(t);
        await rpc.call("addTask", { title: p.title, tags: p.tags, link: p.link, projectId: projectFilter || null });
      }
      setTitle("");
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false); setSmartBusy(false);
    }
  }, [rpc, title, projectFilter, load]);

  const move = useCallback(async (id: string, stage: Stage, beforeId?: string) => {
    const dragged = [...open, ...done].find((t) => t.id === id);
    if (!dragged) return;
    try {
      if (dragged.stage !== stage) {
        await rpc.call("setStage", { id, stage });
        if (beforeId) await rpc.call("reorder", { id, beforeId, afterId: null });
      } else if (beforeId && beforeId !== id) {
        await rpc.call("reorder", { id, beforeId, afterId: null });
      }
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [rpc, open, done, load]);

  const setStatus = useCallback(async (task: Task) => {
    try { await rpc.call("setStatus", { id: task.id, status: task.status === "done" ? "open" : "done" }); await load(); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [rpc, load]);
  const urgent = useCallback(async (task: Task) => {
    try { await rpc.call("updateTask", { id: task.id, urgent: !task.urgent }); await load(); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [rpc, load]);
  const remove = useCallback(async (task: Task) => {
    try { await rpc.call("deleteTask", { id: task.id }); await load(); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [rpc, load]);
  const archive = useCallback(async (task: Task, val: boolean) => {
    try { await rpc.call("archiveTask", { id: task.id, archived: val }); await load(); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [rpc, load]);
  const addLink = useCallback(async (task: Task) => {
    const url = window.prompt("Attach a link (PR, Slack thread, doc, URL):", "");
    if (!url || !url.trim()) return;
    let clean = url.trim();
    if (!/^https?:\/\//i.test(clean)) clean = `https://${clean}`;
    try {
      // Consolidate the legacy single link + the new one into the links array.
      await rpc.call("updateTask", { id: task.id, links: [...task.links, clean], link: null });
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [rpc, load]);

  return (
    <div className="relative flex h-full flex-col bg-background">
      <style>{TRACKER_FX}</style>
      <header className="flex flex-col gap-2.5 border-b border-border/60 px-3 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          {tabs}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              title={showArchived ? "Back to board" : "Show archived"}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors",
                showArchived ? "border-primary/40 bg-primary/10 text-primary" : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon name="Archive" className="size-3.5" aria-hidden />
              {archivedList.length > 0 && <span className="tabular-nums">{archivedList.length}</span>}
            </button>
            <div className="relative">
              <Icon name="Search" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={search} placeholder="Search" onChange={(e) => setSearch(e.target.value)} className="h-8 w-32 rounded-lg pl-7 text-xs sm:w-44" />
            </div>
            {projects.length > 1 && (
              <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className="h-8 rounded-lg border border-border/60 bg-card px-2 text-xs text-foreground">
                <option value="">All projects</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Input
            id="kanban-add"
            value={title}
            placeholder="Add a task…  #tag  tomorrow  https://…"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(e.metaKey || e.ctrlKey); }}
            className="h-9 flex-1 rounded-lg text-sm"
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => add(true)} disabled={smartBusy || !title.trim()} aria-label="Smart add" className="h-9 gap-1 px-2 text-muted-foreground">
            <Icon name={smartBusy ? "Loading" : "Robot"} className={cn("size-4", smartBusy && "animate-spin")} aria-hidden />
          </Button>
          <Button type="button" size="sm" onClick={() => add(false)} disabled={busy || !title.trim()} className="h-9 gap-1 px-3">
            <Icon name="Plus" className="size-4" aria-hidden /> Add
          </Button>
        </div>
      </header>

      {showArchived ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {archivedList.length === 0 ? (
            <div className="mx-auto mt-16 max-w-xs text-center text-sm text-muted-foreground">Nothing archived yet.</div>
          ) : (
            <div className="[column-gap:12px] [column-width:280px]">
              {archivedList.map((t) => (
                <div key={t.id} className="mb-3 break-inside-avoid rounded-xl border border-border/60 bg-card p-3">
                  <button type="button" onClick={() => setSelectedId(t.id)} className="block w-full text-left">
                    <div className="text-sm font-medium leading-snug">{t.title}</div>
                    {t.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {t.tags.slice(0, 4).map((x) => (
                          <span key={x} className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">#{x}</span>
                        ))}
                      </div>
                    )}
                  </button>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span title={t.archivedAt ? new Date(t.archivedAt).toLocaleString() : ""}>
                      archived {t.archivedAt ? relFromNow(t.archivedAt) : ""}
                    </span>
                    <button type="button" onClick={() => archive(t, false)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-muted hover:text-foreground">
                      <Icon name="ArchiveRestore" className="size-3.5" aria-hidden /> Restore
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full min-w-max gap-3 p-3">
          {COLUMNS.map((col) => {
            const items = columns[col.id];
            return (
              <section
                key={col.id}
                onDragOver={(e) => { e.preventDefault(); setOverCol(col.id); }}
                onDragLeave={() => setOverCol((s) => (s === col.id ? null : s))}
                onDrop={(e) => { e.preventDefault(); setOverCol(null); if (dragId) move(dragId, col.id); }}
                className={cn(
                  "flex w-[300px] flex-col rounded-2xl border bg-muted/25 transition-colors",
                  overCol === col.id ? "border-primary/50 bg-primary/5" : "border-border/50",
                )}
              >
                <div className="flex items-center gap-2 px-3.5 pb-2 pt-3">
                  <Icon name={col.icon} className={cn("size-4", col.tint, col.id === "doing" && "animate-spin")} aria-hidden />
                  <span className="text-sm font-semibold tracking-tight">{col.label}</span>
                  <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">{items.length}</span>
                  <button type="button" onClick={() => document.getElementById("kanban-add")?.focus()} className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" title={`Add to ${col.label}`}>
                    <Icon name="Plus" className="size-4" aria-hidden />
                  </button>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2.5 pb-3">
                  {items.length === 0 ? (
                    <div className="mt-6 rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground/70">
                      {col.id === "done" ? "Completed tasks land here" : col.id === "hold" ? "Parked tasks land here" : "Drop tasks here"}
                    </div>
                  ) : (
                    items.map((task) => (
                      <KanbanCard
                        key={task.id}
                        task={task}
                        dragging={dragId === task.id}
                        onDragStart={() => setDragId(task.id)}
                        onDragEnd={() => setDragId(null)}
                        onDropBefore={() => { if (dragId) move(dragId, col.id, task.id); }}
                        onOpen={() => setSelectedId(task.id)}
                        onOpenComplete={() => setStatus(task)}
                        onUrgent={() => urgent(task)}
                        onDelete={() => remove(task)}
                        onArchive={() => archive(task, true)}
                        onAddLink={() => addLink(task)}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      )}
      {selectedTask && (
        <TaskDetail
          key={selectedTask.id}
          task={selectedTask}
          projects={projects}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Initiatives — a project/idea/effort that groups tasks + tracks state/updates
// ===========================================================================

function InitiativeCard({
  initiative,
  onOpen,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  initiative: Initiative;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const col = initiativeCol(initiative.status);
  const pct = initiative.taskCount ? Math.round((initiative.doneCount / initiative.taskCount) * 100) : 0;
  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        const el = e.target as HTMLElement;
        if (el.closest("button,a,input")) return;
        onOpen();
      }}
      className={cn(
        "group/ic cursor-pointer rounded-xl border border-border/60 bg-card p-3 shadow-sm transition-all hover:border-primary/40 hover:shadow-md",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon name={col.icon} className={cn("mt-0.5 size-4 shrink-0", col.tint)} aria-hidden />
        <h4 className="min-w-0 flex-1 text-sm font-semibold leading-snug tracking-tight text-foreground">{initiative.title}</h4>
      </div>
      {initiative.description && (
        <p className="mt-1.5 line-clamp-2 pl-6 text-xs leading-relaxed text-muted-foreground">{initiative.description}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[11px] text-muted-foreground">
        <span className="font-mono">#{initiative.seq}</span>
        {(() => {
          const active = initiative.phases.find((p) => p.status === "active");
          const done = initiative.phases.filter((p) => p.status === "done").length;
          if (!initiative.phases.length) return null;
          return (
            <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary" title={`Phase ${done}/${initiative.phases.length}`}>
              <Icon name="Layers" className="size-3" aria-hidden />
              {active ? active.name : `${done}/${initiative.phases.length}`}
            </span>
          );
        })()}
        {initiative.taskCount > 0 && (
          <span className="inline-flex items-center gap-1" title={`${initiative.doneCount}/${initiative.taskCount} tasks done`}>
            <Icon name="CircleCheck" className="size-3" aria-hidden />
            {initiative.doneCount}/{initiative.taskCount}
          </span>
        )}
        {initiative.threadIds.length > 0 && (
          <span className="inline-flex items-center gap-1"><Icon name="MessageSquare" className="size-3" aria-hidden />{initiative.threadIds.length}</span>
        )}
        {initiative.tags.slice(0, 3).map((g) => (
          <span key={g} className="rounded bg-muted/60 px-1.5 py-0.5">#{g}</span>
        ))}
        <span className="ml-auto" title={new Date(initiative.updatedAt).toLocaleString()}>{relFromNow(initiative.updatedAt)}</span>
      </div>
      {initiative.taskCount > 0 && (
        <div className="mt-2 ml-6 h-1 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full transition-all", pct === 100 ? "bg-emerald-500" : "bg-primary")} style={{ width: `${pct}%` }} />
        </div>
      )}
    </article>
  );
}

function InitiativesView({ tabs, openInitiativeId }: { tabs: ReactNode; openInitiativeId?: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const [items, setItems] = useState<Initiative[]>([]);
  const [archived, setArchived] = useState<Initiative[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<InitiativeStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const [live, arch] = await Promise.all([
        rpc.call("listInitiatives", {}) as Promise<{ initiatives: Initiative[] }>,
        rpc.call("listInitiatives", { archived: true }) as Promise<{ initiatives: Initiative[] }>,
      ]);
      setItems(live.initiatives);
      setArchived(arch.initiatives);
    } catch (e) { toast.error(errorMessage(e)); }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);
  useRealtime("tracker", () => void load());
  useEffect(() => { if (openInitiativeId) setSelectedId(openInitiativeId); }, [openInitiativeId]);

  const columns: Record<InitiativeStatus, Initiative[]> = {
    idea: items.filter((i) => i.status === "idea"),
    active: items.filter((i) => i.status === "active"),
    paused: items.filter((i) => i.status === "paused"),
    shipped: items.filter((i) => i.status === "shipped"),
  };
  const selected =
    [...items, ...archived].find((i) => i.id === selectedId) ?? null;
  useEffect(() => { if (selectedId && !selected) setSelectedId(null); }, [selectedId, selected]);

  const add = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const r = (await rpc.call("addInitiative", { title: t })) as { initiative: Initiative };
      setTitle("");
      await load();
      setSelectedId(r.initiative.id);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const move = async (id: string, status: InitiativeStatus) => {
    const it = items.find((i) => i.id === id);
    if (!it || it.status === status) return;
    try { await rpc.call("setInitiativeStatus", { id, status }); await load(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          {tabs}
          <button
            type="button"
            onClick={() => setShowArchived((s) => !s)}
            className={cn("ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs", showArchived ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted")}
          >
            <Icon name="Archive" className="size-3.5" aria-hidden /> {showArchived ? "Board" : `Archive ${archived.length || ""}`.trim()}
          </button>
        </div>
        {!showArchived && (
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card px-2 py-1 focus-within:border-primary/40">
            <Icon name="Zap" className="size-4 text-muted-foreground" aria-hidden />
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
              placeholder="New initiative — a project, idea or effort…"
              className="flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground/60"
            />
            <Button type="button" size="sm" onClick={() => void add()} disabled={!title.trim() || busy} className="h-7 gap-1 px-2">
              <Icon name="Plus" className="size-4" aria-hidden /> Add
            </Button>
          </div>
        )}
      </div>

      {showArchived ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {archived.length === 0 ? (
            <p className="mt-10 text-center text-sm text-muted-foreground">No archived initiatives.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {archived.map((i) => (
                <InitiativeCard key={i.id} initiative={i} dragging={false} onDragStart={() => {}} onDragEnd={() => {}} onOpen={() => setSelectedId(i.id)} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex h-full min-w-max gap-3 p-3">
            {INITIATIVE_COLUMNS.map((col) => {
              const list = columns[col.id];
              return (
                <section
                  key={col.id}
                  onDragOver={(e) => { e.preventDefault(); setOverCol(col.id); }}
                  onDragLeave={() => setOverCol((s) => (s === col.id ? null : s))}
                  onDrop={(e) => { e.preventDefault(); setOverCol(null); if (dragId) void move(dragId, col.id); }}
                  className={cn("flex w-[300px] flex-col rounded-2xl border bg-muted/25 transition-colors", overCol === col.id ? "border-primary/50 bg-primary/5" : "border-border/50")}
                >
                  <div className="flex items-center gap-2 px-3.5 pb-2 pt-3">
                    <Icon name={col.icon} className={cn("size-4", col.tint)} aria-hidden />
                    <span className="text-sm font-semibold tracking-tight">{col.label}</span>
                    <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">{list.length}</span>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2.5 pb-3">
                    {list.length === 0 ? (
                      <div className="mt-6 rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground/70">
                        {col.id === "shipped" ? "Shipped initiatives land here" : "Drop initiatives here"}
                      </div>
                    ) : (
                      list.map((i) => (
                        <InitiativeCard
                          key={i.id}
                          initiative={i}
                          dragging={dragId === i.id}
                          onDragStart={() => setDragId(i.id)}
                          onDragEnd={() => setDragId(null)}
                          onOpen={() => setSelectedId(i.id)}
                        />
                      ))
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {selected && <InitiativeDetail initiative={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function InitiativeDetail({ initiative, onClose }: { initiative: Initiative; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [title, setTitle] = useState(initiative.title);
  const [description, setDescription] = useState(initiative.description ?? "");
  const [status, setStatus] = useState<InitiativeStatus>(initiative.status);
  const [tags, setTags] = useState<string[]>(initiative.tags);
  const [links, setLinks] = useState<string[]>(initiative.links);
  const [updates, setUpdates] = useState<InitiativeUpdate[]>(initiative.updates);
  const [phases, setPhases] = useState<InitiativePhase[]>(initiative.phases);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [phaseInput, setPhaseInput] = useState("");
  const [upInput, setUpInput] = useState("");
  const [upPhase, setUpPhase] = useState<string>("");
  const [pickTask, setPickTask] = useState(false);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [taskQ, setTaskQ] = useState("");
  const [width, setWidth] = useState(() => {
    const v = Number(typeof localStorage !== "undefined" ? localStorage.getItem("atlas-initiative-drawer-w") : 0);
    return v >= 340 && v <= 820 ? v : 460;
  });
  useEffect(() => { try { localStorage.setItem("atlas-initiative-drawer-w", String(width)); } catch { /* ignore */ } }, [width]);
  const onResizeStart = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const mv = (ev: MouseEvent) => setWidth(Math.min(820, Math.max(340, startW + (startX - ev.clientX))));
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
  };

  const loadDetail = useCallback(async () => {
    try {
      const r = (await rpc.call("getInitiative", { id: initiative.id })) as { initiative: Initiative; tasks: Task[] };
      setUpdates(r.initiative.updates);
      setPhases(r.initiative.phases);
      setTasks(r.tasks);
    } catch { /* ignore */ }
  }, [rpc, initiative.id]);
  useEffect(() => { void loadDetail(); }, [loadDetail]);

  const patch = (p: Record<string, unknown>) =>
    rpc.call("updateInitiative", { id: initiative.id, ...p }).catch((e) => toast.error(errorMessage(e)));
  const changeStatus = (s: InitiativeStatus) => {
    setStatus(s);
    rpc.call("setInitiativeStatus", { id: initiative.id, status: s }).catch((e) => toast.error(errorMessage(e)));
  };
  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, "").toLowerCase();
    if (!t) return;
    const next = [...new Set([...tags, t])];
    setTags(next); void patch({ tags: next }); setTagInput("");
  };
  const delTag = (t: string) => { const next = tags.filter((x) => x !== t); setTags(next); void patch({ tags: next }); };
  const addLink = () => {
    let u = linkInput.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    const next = [...new Set([...links, u])];
    setLinks(next); void patch({ links: next }); setLinkInput("");
  };
  const delLink = (u: string) => { const next = links.filter((x) => x !== u); setLinks(next); void patch({ links: next }); };

  // ----- roadmap phases -----
  const activePhase = phases.find((p) => p.status === "active") ?? null;
  const savePhases = (next: InitiativePhase[]) => {
    setPhases(next);
    rpc.call("setInitiativePhases", { id: initiative.id, phases: next }).catch((e) => toast.error(errorMessage(e)));
  };
  const addPhase = () => {
    const n = phaseInput.trim();
    if (!n) return;
    savePhases([...phases, { id: newPhaseId(), name: n, status: "pending" }]);
    setPhaseInput("");
  };
  const cyclePhase = (id: string) => savePhases(phases.map((p) => (p.id === id ? { ...p, status: NEXT_PHASE_STATUS[p.status] } : p)));
  const renamePhase = (id: string, name: string) => savePhases(phases.map((p) => (p.id === id ? { ...p, name } : p)));
  const movePhase = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= phases.length) return;
    const next = [...phases];
    [next[i], next[j]] = [next[j]!, next[i]!];
    savePhases(next);
  };
  const removePhase = (id: string) => savePhases(phases.filter((p) => p.id !== id));
  const seedPhases = () => savePhases(DEFAULT_PHASE_TEMPLATE.map((name, i) => ({ id: newPhaseId(i), name, status: i === 0 ? "active" : "pending" })));

  const postUpdate = async (withStatus?: InitiativeStatus) => {
    const t = upInput.trim();
    if (!t) return;
    setUpInput("");
    try {
      const r = (await rpc.call("addInitiativeUpdate", {
        id: initiative.id,
        text: t,
        status: withStatus ?? null,
        phaseId: upPhase || activePhase?.id || null,
      })) as { initiative: Initiative };
      setUpdates(r.initiative.updates);
      if (withStatus) setStatus(withStatus);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const phaseName = (id: string | null | undefined) => (id ? phases.find((p) => p.id === id)?.name ?? null : null);
  const openTaskPicker = async () => {
    const next = !pickTask;
    setPickTask(next);
    if (next) {
      try { const r = (await rpc.call("listTasks", { view: "all" })) as { tasks: Task[] }; setAllTasks(r.tasks); } catch { setAllTasks([]); }
    }
  };
  const assignTask = async (taskId: string) => {
    try { await rpc.call("setTaskInitiative", { taskId, initiativeId: initiative.id }); setPickTask(false); setTaskQ(""); await loadDetail(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const unassignTask = async (taskId: string) => {
    try { await rpc.call("setTaskInitiative", { taskId, initiativeId: null }); await loadDetail(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const copyRef = async () => {
    const ref = `Atlas initiative #${initiative.seq}: "${initiative.title}" (id: ${initiative.id})`;
    try { await navigator.clipboard.writeText(ref); toast.success(`Copied initiative #${initiative.seq}`); }
    catch { toast.error("Couldn't copy"); }
  };

  const assignedIds = new Set(tasks.map((t) => t.id));
  const q = taskQ.trim().toLowerCase();
  const taskCandidates = allTasks.filter((t) => !assignedIds.has(t.id)).filter((t) => !q || t.title.toLowerCase().includes(q)).slice(0, 40);
  const doneN = tasks.filter((t) => t.status === "done").length;

  return (
    <div className="absolute inset-0 z-30">
      <button className="tr-scrim absolute inset-0 h-full w-full cursor-default bg-black/50 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <aside style={{ width: `${width}px`, maxWidth: "96%" }} className="tr-drawer absolute right-0 top-0 flex h-full flex-col border-l border-border bg-background shadow-2xl backdrop-blur-2xl">
        <div onMouseDown={onResizeStart} title="Drag to resize" className="group/resize absolute inset-y-0 left-0 z-20 flex w-2 -translate-x-1/2 cursor-col-resize items-stretch justify-center">
          <span className="w-px bg-transparent transition-colors group-hover/resize:w-0.5 group-hover/resize:bg-primary/60" />
        </div>

        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
            {INITIATIVE_COLUMNS.map((c) => (
              <button key={c.id} type="button" onClick={() => changeStatus(c.id)}
                className={cn("inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-all", status === c.id ? cn("bg-background shadow-sm ring-1 ring-border/60", c.tint) : "text-muted-foreground hover:text-foreground")}>
                <Icon name={c.icon} className="size-3.5" aria-hidden />
                {c.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            <button type="button" onClick={copyRef} title="Copy initiative reference" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <Icon name="Copy" className="size-4" aria-hidden />
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <Icon name="X" className="size-4" aria-hidden />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <textarea value={title} onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { const t = title.trim(); if (t && t !== initiative.title) void patch({ title: t }); }}
            rows={1} placeholder="Initiative title"
            className="w-full resize-none border-0 bg-transparent p-0 text-lg font-semibold leading-snug tracking-tight text-foreground outline-none placeholder:text-muted-foreground" />

          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">About</div>
            <MarkdownField
              value={description}
              placeholder="What is this and what's the goal?  (Markdown supported)"
              onSave={(t) => { setDescription(t); void patch({ description: t || null }); }}
            />
          </section>

          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Roadmap</span>
              {phases.length > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{phases.filter((p) => p.status === "done").length}/{phases.length}</span>}
              {activePhase && (
                <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                  <Icon name="Play" className="size-2.5" aria-hidden /> {activePhase.name}
                </span>
              )}
            </div>
            {phases.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-center">
                <p className="text-xs text-muted-foreground/70">No roadmap yet — track this initiative through named stages.</p>
                <button type="button" onClick={seedPhases} className="mt-2 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                  <Icon name="Layers" className="size-3.5" aria-hidden /> Add product phases
                </button>
              </div>
            ) : (
              <div className="space-y-1">
                {phases.map((p, i) => {
                  const meta = PHASE_META[p.status];
                  return (
                    <div key={p.id} className="group/ph flex items-center gap-2 rounded-lg border border-border/50 bg-card px-2 py-1.5">
                      <button type="button" onClick={() => cyclePhase(p.id)} title={`${meta.label} — click to advance`} className={cn("grid size-6 shrink-0 place-items-center rounded-md hover:bg-muted", meta.tint)}>
                        <Icon name={meta.icon} className="size-4" aria-hidden />
                      </button>
                      <input
                        defaultValue={p.name}
                        onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== p.name) renamePhase(p.id, v); else if (!v) e.target.value = p.name; }}
                        className={cn("min-w-0 flex-1 border-0 bg-transparent text-sm outline-none", p.status === "done" ? "text-muted-foreground line-through" : "text-foreground")}
                      />
                      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/ph:opacity-100">
                        <button type="button" onClick={() => movePhase(i, -1)} disabled={i === 0} aria-label="Move up" className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"><Icon name="ChevronUp" className="size-3.5" aria-hidden /></button>
                        <button type="button" onClick={() => movePhase(i, 1)} disabled={i === phases.length - 1} aria-label="Move down" className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"><Icon name="ChevronDown" className="size-3.5" aria-hidden /></button>
                        <button type="button" onClick={() => removePhase(p.id)} aria-label="Remove phase" className="grid size-5 place-items-center rounded text-muted-foreground hover:text-destructive"><Icon name="X" className="size-3.5" aria-hidden /></button>
                      </div>
                    </div>
                  );
                })}
                <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card px-2 py-1 focus-within:border-primary/40">
                  <Icon name="Plus" className="size-3.5 text-muted-foreground" aria-hidden />
                  <input value={phaseInput} onChange={(e) => setPhaseInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addPhase(); }}
                    placeholder="Add a phase…" className="flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground/60" />
                </div>
              </div>
            )}
          </section>

          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tasks</span>
              {tasks.length > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{doneN}/{tasks.length}</span>}
              <button type="button" onClick={() => void openTaskPicker()} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
                <Icon name={pickTask ? "X" : "Plus"} className="size-3" aria-hidden /> {pickTask ? "Close" : "Add task"}
              </button>
            </div>
            {tasks.length > 0 && (
              <div className="mb-2 space-y-1.5">
                {tasks.map((t) => {
                  const col = COLUMNS.find((c) => c.id === t.stage);
                  return (
                    <div key={t.id} className="group/it flex items-center gap-2 rounded-lg border border-border/50 bg-card px-2.5 py-1.5">
                      <Icon name={col?.icon ?? "Target"} className={cn("size-3.5 shrink-0", col?.tint)} aria-hidden />
                      <button type="button" onClick={() => nav.toPluginPanel("tracker", { subPath: t.id })} className={cn("min-w-0 flex-1 truncate text-left text-sm hover:text-primary hover:underline", t.status === "done" && "text-muted-foreground line-through")} title="Open in board">
                        {t.title}
                      </button>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{t.seq}</span>
                      <button type="button" onClick={() => void unassignTask(t.id)} aria-label="Remove from initiative" className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/it:opacity-100">
                        <Icon name="X" className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {pickTask && (
              <div className="rounded-lg border border-border/60 bg-card p-1.5">
                <input value={taskQ} onChange={(e) => setTaskQ(e.target.value)} autoFocus placeholder="Search tasks to add…"
                  className="w-full bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground/60" />
                <div className="mt-1 max-h-52 space-y-0.5 overflow-y-auto">
                  {taskCandidates.length === 0 ? (
                    <p className="px-1.5 py-1 text-xs text-muted-foreground">No tasks found.</p>
                  ) : (
                    taskCandidates.map((t) => {
                      const col = COLUMNS.find((c) => c.id === t.stage);
                      return (
                        <button key={t.id} type="button" onClick={() => void assignTask(t.id)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted">
                          <Icon name={col?.icon ?? "Target"} className={cn("size-3.5 shrink-0", col?.tint)} aria-hidden />
                          <span className="min-w-0 flex-1 truncate">{t.title}</span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{t.seq}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </section>

          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Links</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {links.map((u) => {
                const k = linkKind(u);
                return (
                  <span key={u} className="group/l inline-flex items-center gap-1 rounded-md border border-border/60 bg-card px-2 py-1 text-xs">
                    <Icon name={k.icon} className="size-3.5 text-muted-foreground" aria-hidden />
                    <a href={u} target="_blank" rel="noreferrer" className="max-w-[160px] truncate text-foreground hover:text-primary hover:underline">{k.label}</a>
                    <button type="button" onClick={() => delLink(u)} className="opacity-0 transition-opacity hover:text-destructive group-hover/l:opacity-100"><Icon name="X" className="size-3" aria-hidden /></button>
                  </span>
                );
              })}
              <input value={linkInput} onChange={(e) => setLinkInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addLink(); }}
                placeholder="add link" className="w-28 border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground" />
            </div>
          </section>

          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tags</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map((t) => (
                <span key={t} className="group/tag inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
                  #{t}
                  <button type="button" onClick={() => delTag(t)} className="opacity-0 transition-opacity hover:text-destructive group-hover/tag:opacity-100"><Icon name="X" className="size-3" aria-hidden /></button>
                </span>
              ))}
              <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addTag(); }}
                placeholder="add tag" className="w-24 border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground" />
            </div>
          </section>

          <InitiativeThreads initiativeId={initiative.id} threadIds={initiative.threadIds} />

          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Updates</span>
              {updates.length > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{updates.length}</span>}
            </div>
            {updates.length > 0 && (
              <div className="mb-2 space-y-2">
                {[...updates].reverse().map((u) => {
                  const col = u.status ? initiativeCol(u.status) : null;
                  const ph = phaseName(u.phaseId);
                  return (
                    <div key={u.id} className="rounded-lg border border-border/50 bg-card px-3 py-2">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Icon name="Sent" className="size-3 text-muted-foreground" aria-hidden />
                        <span className="text-[10.5px] text-muted-foreground" title={new Date(u.at).toLocaleString()}>{relFromNow(u.at)}</span>
                        {ph && <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 text-[10px] text-primary"><Icon name="Layers" className="size-2.5" aria-hidden />{ph}</span>}
                        {col && <span className={cn("inline-flex items-center gap-1 rounded px-1.5 text-[10px]", col.tint)}><Icon name={col.icon} className="size-2.5" aria-hidden />{col.label}</span>}
                      </div>
                      <div className="text-sm leading-relaxed text-foreground"><Markdown content={u.text} /></div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="rounded-lg border border-border/60 bg-card p-1.5 focus-within:border-primary/40">
              {phases.length > 0 && (
                <div className="mb-1 flex items-center gap-1.5 px-1">
                  <Icon name="Layers" className="size-3 text-muted-foreground" aria-hidden />
                  <select
                    value={upPhase || activePhase?.id || ""}
                    onChange={(e) => setUpPhase(e.target.value)}
                    className="bg-transparent text-[11px] text-muted-foreground outline-none"
                  >
                    <option value="">No phase</option>
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex items-end gap-2">
                <textarea value={upInput} onChange={(e) => setUpInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void postUpdate(); } }}
                  rows={1} placeholder="Post a progress update…  ⏎ to post"
                  className="max-h-28 min-h-[32px] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/60" />
                <button type="button" onClick={() => void postUpdate()} disabled={!upInput.trim()} aria-label="Post update" className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40">
                  <Icon name="Sent" className="size-3.5" aria-hidden />
                </button>
              </div>
            </div>
          </section>
        </div>

        <div className="flex items-center justify-between border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="font-mono">#{initiative.seq}</span>
            <span title={new Date(initiative.createdAt).toLocaleString()}>· added {new Date(initiative.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
            {initiative.updatedAt > initiative.createdAt && <span title={new Date(initiative.updatedAt).toLocaleString()}>· updated {relFromNow(initiative.updatedAt)}</span>}
          </span>
          <div className="flex items-center gap-1">
            <button type="button"
              onClick={() => { const archiving = initiative.archivedAt == null; rpc.call("archiveInitiative", { id: initiative.id, archived: archiving }).then(() => { if (archiving) onClose(); }).catch((e) => toast.error(errorMessage(e))); }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-muted hover:text-foreground">
              <Icon name={initiative.archivedAt ? "ArchiveRestore" : "Archive"} className="size-3.5" aria-hidden /> {initiative.archivedAt ? "Unarchive" : "Archive"}
            </button>
            <button type="button" onClick={() => rpc.call("deleteInitiative", { id: initiative.id }).then(onClose).catch((e) => toast.error(errorMessage(e)))}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-destructive/10 hover:text-destructive">
              <Icon name="Trash2" className="size-3.5" aria-hidden /> Delete
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Linked chats for an initiative. */
function InitiativeThreads({ initiativeId, threadIds }: { initiativeId: string; threadIds: string[] }) {
  const rpc = useRpc<typeof rpcContract>();
  return (
    <LinkedChats
      threadIds={threadIds}
      fetchRefs={async () => ((await rpc.call("initiativeThreadRefs", { id: initiativeId })) as { threads: ThreadRef[] }).threads}
      onLink={async (id) => { await rpc.call("linkInitiativeThread", { initiativeId, threadId: id }); }}
      onUnlink={async (id) => { await rpc.call("unlinkInitiativeThread", { initiativeId, threadId: id }); }}
    />
  );
}

// ===========================================================================
// Practice — spaced-repetition learning (daily ~1h session + review queue)
// ===========================================================================

/**
 * A draggable, resizable, minimizable floating window (self-contained — no dep;
 * `react-rnd` / `react-draggable` are the OSS equivalents if we ever swap).
 * Position/size/minimized persist across remounts via PANEL_STORE.
 */
function FloatingWindow({
  title, subtitle, icon, onClose, storeKey, defaultPos, children,
}: {
  title: string; subtitle?: string; icon?: IconName; onClose: () => void;
  storeKey: string; defaultPos?: { x: number; y: number }; children: ReactNode;
}) {
  const [pos, setPos] = usePersistentState(`${storeKey}.pos`, defaultPos ?? { x: 48, y: 64 });
  const [size, setSize] = usePersistentState(`${storeKey}.size`, { w: 400, h: 480 });
  const [min, setMin] = usePersistentState(`${storeKey}.min`, false);
  const winRef = useRef<HTMLDivElement | null>(null);

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, px = pos.x, py = pos.y;
    const pr = (winRef.current?.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      let nx = px + (ev.clientX - sx), ny = py + (ev.clientY - sy);
      if (pr) { nx = Math.max(0, Math.min(nx, pr.width - 90)); ny = Math.max(0, Math.min(ny, pr.height - 36)); }
      setPos({ x: nx, y: ny });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, sw = size.w, sh = size.h;
    const move = (ev: PointerEvent) => setSize({ w: Math.max(300, sw + (ev.clientX - sx)), h: Math.max(240, sh + (ev.clientY - sy)) });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  return (
    <div ref={winRef} style={{ left: pos.x, top: pos.y, width: size.w, height: min ? undefined : size.h }}
      className="absolute z-40 flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
      <div onPointerDown={startDrag} className="flex shrink-0 cursor-grab select-none items-center gap-2 border-b border-border/60 bg-card px-3 py-2 active:cursor-grabbing">
        {icon && <Icon name={icon} className="size-4 text-primary" aria-hidden />}
        <span className="text-sm font-semibold">{title}</span>
        {subtitle && <span className="truncate text-[11px] text-muted-foreground">· {subtitle}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" onClick={() => setMin((m) => !m)} aria-label={min ? "Expand" : "Minimize"} className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
            <Icon name={min ? "ChevronUp" : "ChevronDown"} className="size-4" aria-hidden />
          </button>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
            <Icon name="X" className="size-4" aria-hidden />
          </button>
        </div>
      </div>
      {!min && (
        <div className="relative min-h-0 flex-1">
          {children}
          <div onPointerDown={startResize} className="absolute bottom-0 right-0 z-10 size-4 cursor-nwse-resize" aria-hidden>
            <div className="absolute bottom-1 right-1 size-2 border-b-2 border-r-2 border-muted-foreground/40" />
          </div>
        </div>
      )}
    </div>
  );
}

const SD_STAGES = ["Requirements & scope", "API / interface", "Data model", "Scale & bottlenecks", "Tradeoffs & wrap-up"];

/** A lightweight freehand drawing surface for "help me draw a diagram". */
function DiagramCanvas() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const undoStack = useRef<ImageData[]>([]);
  const [color, setColor] = useState("#93c5fd");
  const COLORS = ["#e5e7eb", "#93c5fd", "#fbbf24", "#34d399", "#f87171"];

  useEffect(() => {
    const c = ref.current;
    if (!c || !c.parentElement) return;
    const rect = c.parentElement.getBoundingClientRect();
    c.width = Math.max(1, Math.floor(rect.width));
    c.height = Math.max(1, Math.floor(rect.height));
    const g = c.getContext("2d");
    if (g) { g.lineCap = "round"; g.lineJoin = "round"; g.lineWidth = 2.5; }
  }, []);

  const at = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const c = ref.current, g = c?.getContext("2d");
    if (!c || !g) return;
    undoStack.current.push(g.getImageData(0, 0, c.width, c.height));
    if (undoStack.current.length > 25) undoStack.current.shift();
    drawing.current = true;
    last.current = at(e);
    c.setPointerCapture(e.pointerId);
  };
  const moveP = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const g = ref.current?.getContext("2d");
    if (!g || !last.current) return;
    const p = at(e);
    g.strokeStyle = color;
    g.beginPath();
    g.moveTo(last.current.x, last.current.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last.current = p;
  };
  const up = () => { drawing.current = false; last.current = null; };
  const clear = () => { const c = ref.current, g = c?.getContext("2d"); if (c && g) g.clearRect(0, 0, c.width, c.height); undoStack.current = []; };
  const undo = () => { const c = ref.current, g = c?.getContext("2d"); const s = undoStack.current.pop(); if (c && g && s) g.putImageData(s, 0, 0); };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1.5 flex items-center gap-1.5">
        {COLORS.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)} aria-label="colour"
            className={cn("size-5 rounded-full border transition-transform hover:scale-110", color === c ? "ring-2 ring-primary ring-offset-1 ring-offset-card" : "border-border/60")} style={{ background: c }} />
        ))}
        <button type="button" onClick={undo} className="ml-auto rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">Undo</button>
        <button type="button" onClick={clear} className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">Clear</button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-background">
        <canvas ref={ref} onPointerDown={down} onPointerMove={moveP} onPointerUp={up} onPointerLeave={up} className="size-full cursor-crosshair touch-none" />
      </div>
    </div>
  );
}

function PracticeCard({ item, onOpen }: { item: PracticeItem; onOpen: () => void }) {
  const meta = practiceKindMeta(item.kind);
  const due = practiceDueLabel(item.dueAt);
  return (
    <article
      onClick={(e) => { if (!(e.target as HTMLElement).closest("button,a")) onOpen(); }}
      className="group/pc cursor-pointer rounded-xl border border-border/60 bg-card p-3 shadow-sm transition-all hover:border-primary/40 hover:shadow-md"
    >
      <div className="flex items-start gap-2">
        <Icon name={meta.icon} className={cn("mt-0.5 size-4 shrink-0", meta.tint)} aria-hidden />
        <h4 className="min-w-0 flex-1 text-sm font-semibold leading-snug tracking-tight text-foreground">{item.title}</h4>
        <span className={cn("shrink-0 text-[10px] font-medium", PRACTICE_STATUS_TINT[item.status])}>{item.status}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[11px] text-muted-foreground">
        <span className="font-mono">#{item.seq}</span>
        <span className={meta.tint}>{meta.label}</span>
        {item.topic && <span className="rounded bg-muted/60 px-1.5 py-0.5">{item.topic}</span>}
        {item.difficulty && <span>· {item.difficulty}</span>}
        <span className={cn("ml-auto", due === "due now" && "text-amber-500")}>
          <Icon name="Clock" className="mr-0.5 inline size-3" aria-hidden />{due}
        </span>
      </div>
    </article>
  );
}

function PracticeView({ tabs, openItemId }: { tabs: ReactNode; openItemId?: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  // persisted so switching tabs/threads doesn't reset the room (see PANEL_STORE)
  const [sub, setSub] = usePersistentState<"today" | "all">("practice.sub", "today");
  const [items, setItems] = useState<PracticeItem[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [stats, setStats] = useState<PracticeStats | null>(null);
  const [kindFilter, setKindFilter] = usePersistentState<string>("practice.kindFilter", "");
  const [statusFilter, setStatusFilter] = usePersistentState<string>("practice.statusFilter", "");
  const [topicFilter, setTopicFilter] = usePersistentState<string>("practice.topicFilter", "");
  const [search, setSearch] = usePersistentState("practice.search", "");
  const [selectedId, setSelectedId] = usePersistentState<string | null>("practice.selectedId", null);
  // agentic quick add
  const [addText, setAddText] = usePersistentState("practice.addText", "");
  const [adding, setAdding] = useState(false);
  // review session (persisted so an in-progress session survives a tab switch)
  const [queue, setQueue] = usePersistentState<PracticeItem[]>("practice.queue", []);
  const [qi, setQi] = usePersistentState("practice.qi", 0);
  const [revealed, setRevealed] = usePersistentState("practice.revealed", false);
  const [reviewed, setReviewed] = usePersistentState("practice.reviewed", 0);
  const [startTs, setStartTs] = usePersistentState("practice.startTs", 0);
  const [inSession, setInSession] = usePersistentState("practice.inSession", false);
  const [elapsed, setElapsed] = useState(0);
  // per-card workspace state (system design / coding)
  const [codeAnswer, setCodeAnswer] = usePersistentState("practice.codeAnswer", "");
  const [sdNotes, setSdNotes] = usePersistentState("practice.sdNotes", "");
  const [sdStage, setSdStage] = usePersistentState("practice.sdStage", 0);
  // live coach chat alongside the session
  const [coachOpen, setCoachOpen] = usePersistentState("practice.coachOpen", false);
  const [coachThreadId, setCoachThreadId] = usePersistentState<string | null>("practice.coachThreadId", null);
  const [coachLoading, setCoachLoading] = useState(false);
  // in-depth run logging (per-item results + timing) for self-learning
  type RunEntry = { itemId: string; title?: string; kind?: string; topic?: string; grade?: string; seconds?: number };
  const runLog = useRef<RunEntry[]>([]);
  const cardStart = useRef(0);
  // recall drill (active recall)
  const [drillPhase, setDrillPhase] = usePersistentState<"off" | "recall" | "confirm">("practice.drillPhase", "off");
  const [drillQueue, setDrillQueue] = usePersistentState<PracticeItem[]>("practice.drillQueue", []);
  const [drillIdx, setDrillIdx] = usePersistentState("practice.drillIdx", 0);
  const [drillReveal, setDrillReveal] = usePersistentState("practice.drillReveal", false);
  const [drillGot, setDrillGot] = usePersistentState("practice.drillGot", 0);
  const [drillStart, setDrillStart] = usePersistentState("practice.drillStart", 0);

  const load = useCallback(async () => {
    try {
      const r = (await rpc.call("listPractice", {
        kind: kindFilter || null,
        status: (statusFilter || null) as PracticeStatus | null,
        topic: topicFilter || null,
        search: search || null,
      })) as { items: PracticeItem[]; topics: string[]; stats: PracticeStats };
      setItems(r.items);
      setTopics(r.topics);
      setStats(r.stats);
    } catch (e) { toast.error(errorMessage(e)); }
  }, [rpc, kindFilter, statusFilter, topicFilter, search]);
  useEffect(() => { void load(); }, [load]);
  useRealtime("tracker", () => void load());
  useEffect(() => { if (openItemId) { setSub("all"); setSelectedId(openItemId); } }, [openItemId]);

  // live elapsed timer during a session
  useEffect(() => {
    if (!inSession) return;
    const t = setInterval(() => setElapsed(Date.now() - startTs), 1000);
    return () => clearInterval(t);
  }, [inSession, startTs]);
  // reset the per-card workspace + start the per-card timer whenever the card
  // actually changes — but NOT on remount (so persisted work survives a tab switch).
  const cardResetMounted = useRef(false);
  useEffect(() => {
    if (!cardResetMounted.current) { cardResetMounted.current = true; cardStart.current = Date.now(); return; }
    setCodeAnswer(""); setSdNotes(""); setSdStage(0); cardStart.current = Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qi, inSession]);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  const smartAdd = async () => {
    const t = addText.trim();
    if (!t || adding) return;
    setAdding(true);
    try {
      const r = (await rpc.call("smartAddPractice", { text: t })) as { item: PracticeItem; usedAgent: boolean };
      setAddText("");
      await load();
      const it = r.item;
      toast.success(`${r.usedAgent ? "✨ " : ""}Added — ${practiceKindMeta(it.kind).label}${it.topic ? ` · ${it.topic}` : ""}${it.tags.length ? ` · [${it.tags.join(", ")}]` : ""}`);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setAdding(false); }
  };

  // ----- recall drill (active recall): glance → recall → confirm fast -----
  const startDrill = async () => {
    try {
      const r = (await rpc.call("practiceQueue", { newLimit: 10 })) as { due: PracticeItem[]; fresh: PracticeItem[] };
      const q = [...r.due, ...r.fresh].slice(0, 10);
      if (q.length === 0) { toast.success("Nothing to drill — add items or come back tomorrow 🎉"); return; }
      setDrillQueue(q); setDrillPhase("recall"); setDrillIdx(0); setDrillReveal(false); setDrillGot(0); setDrillStart(Date.now());
      runLog.current = []; cardStart.current = Date.now();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const drillConfirm = (got: boolean) => {
    const item = drillQueue[drillIdx];
    if (item) {
      runLog.current.push({ itemId: item.id, title: item.title, kind: item.kind, topic: item.topic ?? undefined, grade: got ? "got" : "missed", seconds: Math.round((Date.now() - cardStart.current) / 1000) });
      void rpc.call("reviewPractice", { id: item.id, grade: got ? "good" : "again" }).catch(() => {});
    }
    const g = drillGot + (got ? 1 : 0);
    setDrillGot(g);
    if (drillIdx + 1 >= drillQueue.length) {
      const minutes = Math.max(1, Math.round((Date.now() - drillStart) / 60000));
      void rpc.call("logPracticeSession", { minutes, reviewed: drillQueue.length, mode: "drill", detail: runLog.current }).catch(() => {});
      toast.success(`Recall drill — ${g}/${drillQueue.length} recalled in ${minutes} min 🔥`);
      setDrillPhase("off");
      void load();
    } else {
      setDrillIdx(drillIdx + 1); setDrillReveal(false); cardStart.current = Date.now();
    }
  };
  const exitDrill = () => setDrillPhase("off");

  const startSession = async () => {
    try {
      const r = (await rpc.call("practiceQueue", { newLimit: 10 })) as { due: PracticeItem[]; fresh: PracticeItem[] };
      const q = [...r.due, ...r.fresh];
      if (q.length === 0) { toast.success("Nothing due — add items or come back tomorrow 🎉"); return; }
      setQueue(q); setQi(0); setRevealed(false); setReviewed(0); setStartTs(Date.now()); setElapsed(0); setInSession(true);
      setCoachOpen(false); setCoachThreadId(null);
      runLog.current = []; cardStart.current = Date.now();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const openCoach = async () => {
    if (coachOpen) { setCoachOpen(false); return; }
    setCoachOpen(true);
    if (!coachThreadId && cur) {
      setCoachLoading(true);
      try {
        const r = (await rpc.call("startPracticeCoach", { itemId: cur.id })) as { threadId: string };
        setCoachThreadId(r.threadId);
      } catch (e) { toast.error(errorMessage(e)); setCoachOpen(false); }
      finally { setCoachLoading(false); }
    }
  };
  const grade = async (g: Grade) => {
    const item = queue[qi];
    if (!item) return;
    runLog.current.push({ itemId: item.id, title: item.title, kind: item.kind, topic: item.topic ?? undefined, grade: g, seconds: Math.round((Date.now() - cardStart.current) / 1000) });
    try { await rpc.call("reviewPractice", { id: item.id, grade: g }); } catch (e) { toast.error(errorMessage(e)); }
    const n = reviewed + 1;
    setReviewed(n);
    if (qi + 1 >= queue.length) void finishSession(n);
    else { setQi(qi + 1); setRevealed(false); }
  };
  const finishSession = async (count: number) => {
    const minutes = Math.max(1, Math.round((Date.now() - startTs) / 60000));
    try { await rpc.call("logPracticeSession", { minutes, reviewed: count, mode: "review", detail: runLog.current }); } catch { /* ignore */ }
    setInSession(false);
    toast.success(`Session done — ${count} reviewed in ${minutes} min 🔥`);
    await load();
  };
  const endSession = async () => {
    if (reviewed > 0) await finishSession(reviewed);
    else setInSession(false);
  };

  const cur = queue[qi];

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          {tabs}
          <div className="ml-auto inline-flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
            {(["today", "all"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSub(s)}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-all", sub === s ? "bg-background text-foreground shadow-sm ring-1 ring-border/60" : "text-muted-foreground hover:text-foreground")}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {sub === "today" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {inSession && cur ? (
            <div className="relative flex h-full flex-col p-4">
              {/* progress */}
              <div className="mb-3 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="tabular-nums">{qi + 1} / {queue.length}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(qi / queue.length) * 100}%` }} />
                </div>
                <span className="tabular-nums">{Math.floor(elapsed / 60000)}m</span>
                <button type="button" onClick={() => void openCoach()}
                  className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium transition-colors", coachOpen ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-primary/10 hover:text-primary")}>
                  <Icon name="Robot" className="size-3.5" aria-hidden /> Coach
                </button>
                <button type="button" onClick={() => void endSession()} className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground">End</button>
              </div>
              {(() => {
                const m = practiceKindMeta(cur.kind);
                const sd = cur.kind === "system-design";
                const coding = cur.kind === "coding";
                const header = (
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={cn("inline-flex items-center gap-1 font-medium", m.tint)}><Icon name={m.icon} className="size-3.5" aria-hidden />{m.label}</span>
                    {cur.topic && <span className="rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground">{cur.topic}</span>}
                    {cur.difficulty && <span className="text-muted-foreground">· {cur.difficulty}</span>}
                    <span className={cn("ml-auto", PRACTICE_STATUS_TINT[cur.status])}>{cur.status}</span>
                  </div>
                );
                const solutionBlock = revealed && (
                  <div className="mt-3 border-t border-border/50 pt-3">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reference solution</div>
                    {cur.solution ? <div className="tr-note-md text-sm leading-relaxed text-foreground"><Markdown content={cur.solution} /></div> : <p className="text-sm text-muted-foreground/70">No solution recorded.</p>}
                  </div>
                );
                const gradeRow = !revealed ? (
                  <button type="button" onClick={() => setRevealed(true)} className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
                    {sd || coding ? "Reveal reference solution" : "Show solution"}
                  </button>
                ) : (
                  <div className="grid grid-cols-4 gap-2">
                    {GRADE_META.map((gm) => <button key={gm.id} type="button" onClick={() => void grade(gm.id)} className={cn("rounded-lg py-2.5 text-sm font-medium transition-colors", gm.cls)}>{gm.label}</button>)}
                  </div>
                );

                if (sd) {
                  return (
                    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
                      <div className="flex min-h-0 flex-col overflow-y-auto rounded-2xl border border-border/60 bg-card p-5">
                        {header}
                        <h3 className="text-xl font-semibold tracking-tight text-foreground">{cur.title}</h3>
                        {cur.question && <div className="tr-note-md mt-2 text-sm leading-relaxed text-foreground"><Markdown content={cur.question} /></div>}
                        <div className="mt-3">
                          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Work through it — stage by stage</div>
                          <div className="flex flex-wrap gap-1.5">
                            {SD_STAGES.map((s, i) => (
                              <button key={s} type="button" onClick={() => setSdStage(i)} className={cn("rounded-full border px-2 py-0.5 text-[11px] transition-colors", sdStage === i ? "border-transparent bg-primary/15 text-primary" : "border-border/60 text-muted-foreground hover:bg-muted")}>{i + 1}. {s}</button>
                            ))}
                          </div>
                          <textarea value={sdNotes} onChange={(e) => setSdNotes(e.target.value)} placeholder={`Notes for “${SD_STAGES[sdStage]}” — think out loud: assumptions, numbers, components, tradeoffs.`}
                            className="mt-2 h-28 w-full resize-none rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-primary/40" />
                        </div>
                        {solutionBlock}
                        <div className="mt-4">{gradeRow}</div>
                      </div>
                      <div className="flex min-h-0 flex-col rounded-2xl border border-border/60 bg-card p-3">
                        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><Icon name="Brain" className="size-3.5" aria-hidden /> Draw the architecture</div>
                        <div className="min-h-0 flex-1"><DiagramCanvas /></div>
                      </div>
                    </div>
                  );
                }
                if (coding) {
                  return (
                    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
                      <div className="flex min-h-0 flex-col overflow-y-auto rounded-2xl border border-border/60 bg-card p-5">
                        {header}
                        <h3 className="text-xl font-semibold tracking-tight text-foreground">{cur.title}</h3>
                        {cur.question && <div className="tr-note-md mt-2 text-sm leading-relaxed text-foreground"><Markdown content={cur.question} /></div>}
                        {solutionBlock}
                        <div className="mt-4">{gradeRow}</div>
                      </div>
                      <div className="flex min-h-0 flex-col rounded-2xl border border-border/60 bg-card p-3">
                        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Your solution</div>
                        <textarea value={codeAnswer} onChange={(e) => setCodeAnswer(e.target.value)} spellCheck={false}
                          placeholder={"// write your solution here — then reveal the reference to compare"}
                          className="min-h-0 w-full flex-1 resize-none rounded-lg border border-border/60 bg-background p-3 font-mono text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-primary/40" />
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
                    {header}
                    <h3 className="text-lg font-semibold tracking-tight text-foreground">{cur.title}</h3>
                    {cur.question && <div className="tr-note-md mt-2 text-sm leading-relaxed text-foreground"><Markdown content={cur.question} /></div>}
                    <div className="min-h-0 flex-1 overflow-y-auto">{solutionBlock}</div>
                    <div className="mt-4">{gradeRow}</div>
                  </div>
                );
              })()}

            </div>
          ) : drillPhase !== "off" ? (
            <div className="mx-auto flex h-full max-w-2xl flex-col p-4">
              {drillPhase === "recall" ? (
                <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
                  <div className="mb-1 flex items-center gap-2">
                    <Icon name="Brain" className="size-4 text-primary" aria-hidden />
                    <h3 className="text-base font-semibold text-foreground">Recall drill · {drillQueue.length} questions</h3>
                    <button type="button" onClick={exitDrill} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                  </div>
                  <p className="mb-3 text-xs text-muted-foreground">Active recall: read each one and answer it in your head (or on paper) — quickly. Then confirm how many you actually knew.</p>
                  <ol className="min-h-0 flex-1 list-decimal space-y-2 overflow-y-auto pl-5">
                    {drillQueue.map((it) => (
                      <li key={it.id} className="text-sm text-foreground">
                        <span className="font-medium">{it.title}</span>
                        {it.question && <span className="text-muted-foreground"> — {it.question.replace(/\s+/g, " ").slice(0, 140)}</span>}
                      </li>
                    ))}
                  </ol>
                  <button type="button" onClick={() => { setDrillPhase("confirm"); setDrillIdx(0); setDrillReveal(false); }}
                    className="mt-4 w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
                    I've recalled them — confirm →
                  </button>
                </div>
              ) : (() => {
                const it = drillQueue[drillIdx];
                if (!it) return null;
                const m = practiceKindMeta(it.kind);
                return (
                  <>
                    <div className="mb-3 flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="tabular-nums">{drillIdx + 1} / {drillQueue.length}</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(drillIdx / drillQueue.length) * 100}%` }} /></div>
                      <span className="tabular-nums text-emerald-500">{drillGot} got</span>
                      <button type="button" onClick={exitDrill} className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground">End</button>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
                      <div className="mb-2 flex items-center gap-2 text-[11px]">
                        <span className={cn("inline-flex items-center gap-1 font-medium", m.tint)}><Icon name={m.icon} className="size-3.5" aria-hidden />{m.label}</span>
                        {it.topic && <span className="rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground">{it.topic}</span>}
                      </div>
                      <h3 className="text-lg font-semibold tracking-tight text-foreground">{it.title}</h3>
                      {it.question && <div className="tr-note-md mt-2 text-sm leading-relaxed text-foreground"><Markdown content={it.question} /></div>}
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        {drillReveal && (
                          <div className="mt-3 border-t border-border/50 pt-3">
                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Solution</div>
                            {it.solution ? <div className="tr-note-md text-sm leading-relaxed text-foreground"><Markdown content={it.solution} /></div> : <p className="text-sm text-muted-foreground/70">No solution recorded.</p>}
                          </div>
                        )}
                      </div>
                      <div className="mt-4">
                        {!drillReveal ? (
                          <button type="button" onClick={() => setDrillReveal(true)} className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">Reveal answer</button>
                        ) : (
                          <div className="grid grid-cols-2 gap-2">
                            <button type="button" onClick={() => drillConfirm(false)} className="rounded-lg bg-rose-500/15 py-2.5 text-sm font-medium text-rose-500 transition-colors hover:bg-rose-500/25">Missed</button>
                            <button type="button" onClick={() => drillConfirm(true)} className="rounded-lg bg-emerald-500/15 py-2.5 text-sm font-medium text-emerald-500 transition-colors hover:bg-emerald-500/25">Got it</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-4 p-4">
              {/* stats hero */}
              <div className="rounded-2xl border border-border/60 bg-gradient-to-br from-primary/5 to-transparent p-5">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">🔥</span>
                  <div>
                    <div className="text-2xl font-bold tracking-tight text-foreground">{stats?.streak ?? 0}-day streak</div>
                    <div className="text-xs text-muted-foreground">{stats?.todayReviewed ? `${stats.todayReviewed} reviewed today · ${stats.todayMinutes} min` : "Nothing practised today yet"}</div>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                  {[
                    { label: "Due", value: stats?.dueToday ?? 0, tint: "text-amber-500" },
                    { label: "New", value: stats?.newAvailable ?? 0, tint: "text-sky-500" },
                    { label: "Mastered", value: stats?.byStatus.mastered ?? 0, tint: "text-emerald-500" },
                    { label: "Total", value: stats?.total ?? 0, tint: "text-foreground" },
                  ].map((s) => (
                    <div key={s.label} className="rounded-lg bg-card/60 py-2">
                      <div className={cn("text-lg font-bold tabular-nums", s.tint)}>{s.value}</div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.label}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 grid grid-cols-[2fr,1fr] gap-2">
                  <button
                    type="button"
                    onClick={() => void startSession()}
                    disabled={(stats?.dueToday ?? 0) + (stats?.newAvailable ?? 0) === 0}
                    className="flex items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    <Icon name="Play" className="size-4" aria-hidden />
                    {(stats?.dueToday ?? 0) + (stats?.newAvailable ?? 0) === 0 ? "All caught up 🎉" : `Start session · ${(stats?.dueToday ?? 0)}+${Math.min(10, stats?.newAvailable ?? 0)}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => void startDrill()}
                    disabled={(stats?.dueToday ?? 0) + (stats?.newAvailable ?? 0) === 0}
                    title="Active recall: glance at ~10, recall them, then confirm fast"
                    className="flex items-center justify-center gap-1.5 rounded-lg border border-primary/40 py-3 text-sm font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
                  >
                    <Icon name="Brain" className="size-4" aria-hidden /> Recall drill
                  </button>
                </div>
                <div className="mt-2 text-center text-[11px] text-muted-foreground">{stats?.minutesThisWeek ?? 0} min · {stats?.reviewedThisWeek ?? 0} reviews this week · aim for ~1h/day</div>
              </div>

              {/* agentic quick add */}
              <div className="rounded-xl border border-border/60 bg-card p-2">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Icon name="Robot" className="size-3.5" aria-hidden /> Add something to learn — the agent tags it
                </div>
                <div className="flex items-center gap-2">
                  <input value={addText} onChange={(e) => setAddText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void smartAdd(); }} disabled={adding}
                    placeholder="e.g. “two sum”, “explain the event loop”, or paste a question…" className="flex-1 bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60" />
                  <Button type="button" size="sm" onClick={() => void smartAdd()} disabled={!addText.trim() || adding} className="h-8 gap-1 px-2">
                    <Icon name={adding ? "Loading" : "Robot"} className={cn("size-4", adding && "animate-spin")} aria-hidden />{adding ? "…" : "Add"}
                  </Button>
                </div>
                <p className="mt-1 px-0.5 text-[10.5px] text-muted-foreground">The agent infers topic, kind, difficulty & tags and drafts a solution. Or ask it to “make practice from my note on X” / “add 5 system-design questions”.</p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {/* filters */}
          <div className="mb-3 space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex flex-1 items-center gap-1.5 rounded-lg border border-border/60 bg-card px-2">
                <Icon name="Search" className="size-3.5 text-muted-foreground" aria-hidden />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search practice…" className="flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/60" />
              </div>
              {topics.length > 0 && (
                <select value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)} className="rounded-lg border border-border/60 bg-card px-2 py-1.5 text-xs text-foreground outline-none">
                  <option value="">All topics</option>
                  {topics.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {PRACTICE_KINDS.map((k) => {
                const m = practiceKindMeta(k);
                const on = kindFilter === k;
                return (
                  <button key={k} type="button" onClick={() => setKindFilter(on ? "" : k)}
                    className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors", on ? cn("border-transparent bg-primary/10", m.tint) : "border-border/60 text-muted-foreground hover:bg-muted")}>
                    <Icon name={m.icon} className="size-3" aria-hidden />{m.label}
                  </button>
                );
              })}
              {(["new", "learning", "review", "mastered"] as PracticeStatus[]).map((s) => (
                <button key={s} type="button" onClick={() => setStatusFilter(statusFilter === s ? "" : s)}
                  className={cn("rounded-full border px-2 py-0.5 text-[11px] capitalize transition-colors", statusFilter === s ? cn("border-transparent bg-primary/10", PRACTICE_STATUS_TINT[s]) : "border-border/60 text-muted-foreground hover:bg-muted")}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          {items.length === 0 ? (
            <p className="mt-10 text-center text-sm text-muted-foreground">No practice items{search || kindFilter || statusFilter || topicFilter ? " match" : " yet — add one from the Today tab or ask the agent"}.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {items.map((it) => <PracticeCard key={it.id} item={it} onOpen={() => setSelectedId(it.id)} />)}
            </div>
          )}
        </div>
      )}

      {selected && <PracticeDetail item={selected} onClose={() => setSelectedId(null)} onChanged={() => void load()} />}

      {coachOpen && (
        <FloatingWindow title="Atlas Coach" subtitle="knows this question" icon="Robot" storeKey="practice.coachWin" onClose={() => setCoachOpen(false)}>
          {coachLoading || !coachThreadId ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Icon name="Loading" className="size-4 animate-spin" aria-hidden /> Waking your coach…
            </div>
          ) : (
            <ThreadChat threadId={coachThreadId} variant="compact" layout="contained" className="h-full" />
          )}
        </FloatingWindow>
      )}
    </div>
  );
}

function PracticeDetail({ item, onClose, onChanged }: { item: PracticeItem; onClose: () => void; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [title, setTitle] = useState(item.title);
  const [topic, setTopic] = useState(item.topic ?? "");
  const [kind, setKind] = useState(item.kind);
  const [difficulty, setDifficulty] = useState(item.difficulty ?? "");
  const [source, setSource] = useState(item.source ?? "");
  const [tags, setTags] = useState<string[]>(item.tags);
  const [tagInput, setTagInput] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [width, setWidth] = useState(() => {
    const v = Number(typeof localStorage !== "undefined" ? localStorage.getItem("atlas-practice-drawer-w") : 0);
    return v >= 340 && v <= 820 ? v : 480;
  });
  useEffect(() => { try { localStorage.setItem("atlas-practice-drawer-w", String(width)); } catch { /* ignore */ } }, [width]);
  const onResizeStart = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const mv = (ev: MouseEvent) => setWidth(Math.min(820, Math.max(340, startW + (startX - ev.clientX))));
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
  };

  const patch = (p: Record<string, unknown>) => rpc.call("updatePractice", { id: item.id, ...p }).then(onChanged).catch((e) => toast.error(errorMessage(e)));
  const addTag = () => { const t = tagInput.trim().replace(/^#/, "").toLowerCase(); if (!t) return; const next = [...new Set([...tags, t])]; setTags(next); void patch({ tags: next }); setTagInput(""); };
  const delTag = (t: string) => { const next = tags.filter((x) => x !== t); setTags(next); void patch({ tags: next }); };
  const review = async (g: Grade) => {
    try { await rpc.call("reviewPractice", { id: item.id, grade: g }); setRevealed(false); onChanged(); toast.success(`Graded — ${g}`); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const meta = practiceKindMeta(kind);

  return (
    <div className="absolute inset-0 z-30">
      <button className="tr-scrim absolute inset-0 h-full w-full cursor-default bg-black/50 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <aside style={{ width: `${width}px`, maxWidth: "96%" }} className="tr-drawer absolute right-0 top-0 flex h-full flex-col border-l border-border bg-background shadow-2xl backdrop-blur-2xl">
        <div onMouseDown={onResizeStart} title="Drag to resize" className="group/resize absolute inset-y-0 left-0 z-20 flex w-2 -translate-x-1/2 cursor-col-resize items-stretch justify-center">
          <span className="w-px bg-transparent transition-colors group-hover/resize:w-0.5 group-hover/resize:bg-primary/60" />
        </div>
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <Icon name={meta.icon} className={cn("size-4", meta.tint)} aria-hidden />
          <span className={cn("text-xs font-medium", meta.tint)}>{meta.label}</span>
          <span className={cn("rounded px-1.5 text-[10px]", PRACTICE_STATUS_TINT[item.status])}>{item.status}</span>
          <span className="text-[11px] text-muted-foreground">· {practiceDueLabel(item.dueAt)} · {item.reps} reps</span>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <Icon name="X" className="size-4" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <textarea value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => { const t = title.trim(); if (t && t !== item.title) void patch({ title: t }); }}
            rows={1} placeholder="Title" className="w-full resize-none border-0 bg-transparent p-0 text-lg font-semibold leading-snug tracking-tight text-foreground outline-none" />

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select value={kind} onChange={(e) => { setKind(e.target.value); void patch({ kind: e.target.value }); }} className="rounded-lg border border-border/60 bg-card px-2 py-1.5 text-foreground outline-none">
              {PRACTICE_KINDS.map((k) => <option key={k} value={k}>{practiceKindMeta(k).label}</option>)}
            </select>
            <select value={difficulty} onChange={(e) => { setDifficulty(e.target.value); void patch({ difficulty: e.target.value || null }); }} className="rounded-lg border border-border/60 bg-card px-2 py-1.5 text-foreground outline-none">
              <option value="">difficulty</option>
              <option value="easy">easy</option><option value="medium">medium</option><option value="hard">hard</option>
            </select>
            <input value={topic} onChange={(e) => setTopic(e.target.value)} onBlur={() => { if (topic !== (item.topic ?? "")) void patch({ topic: topic || null }); }}
              placeholder="topic" className="w-32 rounded-lg border border-border/60 bg-card px-2 py-1.5 text-foreground outline-none placeholder:text-muted-foreground/60" />
          </div>

          {item.noteTitle && (
            <div className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
              <Icon name="FileText" className="size-3.5" aria-hidden />
              Generated from note: <span className="font-medium text-foreground">{item.noteTitle}</span>
            </div>
          )}

          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Question</div>
            <MarkdownField value={item.question ?? ""} placeholder="The prompt / problem (Markdown)…" onSave={(t) => void patch({ question: t || null })} />
          </section>
          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Solution</div>
            <MarkdownField value={item.solution ?? ""} placeholder="The answer / approach / explanation (Markdown)…" onSave={(t) => void patch({ solution: t || null })} />
          </section>

          {/* review now */}
          <section className="rounded-xl border border-primary/30 bg-primary/5 p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-primary">Review now</div>
            {!revealed ? (
              <button type="button" onClick={() => setRevealed(true)} className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Show solution & grade</button>
            ) : (
              <div className="grid grid-cols-4 gap-2">
                {GRADE_META.map((gm) => <button key={gm.id} type="button" onClick={() => void review(gm.id)} className={cn("rounded-lg py-2 text-sm font-medium transition-colors", gm.cls)}>{gm.label}</button>)}
              </div>
            )}
          </section>

          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tags</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map((t) => (
                <span key={t} className="group/tag inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">#{t}
                  <button type="button" onClick={() => delTag(t)} className="opacity-0 transition-opacity hover:text-destructive group-hover/tag:opacity-100"><Icon name="X" className="size-3" aria-hidden /></button>
                </span>
              ))}
              <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addTag(); }} placeholder="add tag" className="w-24 border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground" />
            </div>
          </section>

          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Source</div>
            <input value={source} onChange={(e) => setSource(e.target.value)} onBlur={() => { if (source !== (item.source ?? "")) void patch({ source: source || null }); }}
              placeholder="URL / book / where it came from" className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/60" />
          </section>

          <section className="text-[11px] text-muted-foreground">
            <div className="mb-1 font-semibold uppercase tracking-wide">Schedule</div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <span>due {practiceDueLabel(item.dueAt)}</span>
              <span>· interval {Math.round(item.intervalDays)}d</span>
              <span>· ease {item.ease.toFixed(2)}</span>
              <span>· {item.reps} reps</span>
              {item.lapses > 0 && <span>· {item.lapses} lapses</span>}
              {item.lastReviewedAt && <span>· last {relFromNow(item.lastReviewedAt)}</span>}
            </div>
            {item.reviewLog.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {item.reviewLog.slice(-14).map((r, i) => (
                  <span key={i} title={`${new Date(r.at).toLocaleString()} · ${r.grade} · ${r.intervalDays}d`}
                    className={cn("size-2.5 rounded-full", r.grade === "again" ? "bg-rose-500" : r.grade === "hard" ? "bg-amber-500" : r.grade === "good" ? "bg-emerald-500" : "bg-sky-500")} />
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="flex items-center justify-between border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="font-mono">#{item.seq}</span><span>· added {new Date(item.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span></span>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => { const a = item.archivedAt == null; rpc.call("archivePractice", { id: item.id, archived: a }).then(() => { onChanged(); if (a) onClose(); }).catch((e) => toast.error(errorMessage(e))); }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-muted hover:text-foreground">
              <Icon name={item.archivedAt ? "ArchiveRestore" : "Archive"} className="size-3.5" aria-hidden /> {item.archivedAt ? "Unarchive" : "Archive"}
            </button>
            <button type="button" onClick={() => rpc.call("deletePractice", { id: item.id }).then(() => { onChanged(); onClose(); }).catch((e) => toast.error(errorMessage(e)))}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-destructive/10 hover:text-destructive">
              <Icon name="Trash2" className="size-3.5" aria-hidden /> Delete
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

type Mode = "tasks" | "initiatives" | "practice" | "notes" | "library" | "graph";
const MODES: { id: Mode; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "initiatives", label: "Initiatives" },
  { id: "practice", label: "Practice" },
  { id: "notes", label: "Notes" },
  { id: "library", label: "Library" },
  { id: "graph", label: "Graph" },
];

/** The Tasks/Notes/Graph switch — rendered inline inside each view's header. */
function ModeTabs({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => setMode(m.id)}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-semibold tracking-tight transition-all",
            mode === m.id
              ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

// Ambient motion — subtle, GPU-friendly, and disabled under reduced-motion.
const TRACKER_FX = `
@keyframes tr-fadeup { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
@keyframes tr-urgentglow { 0%,100% { opacity: .6; box-shadow: 0 0 4px 0 rgba(245,158,11,.45); } 50% { opacity: 1; box-shadow: 0 0 11px 1px rgba(245,158,11,.9); } }
@keyframes tr-drift { 0% { transform: translate(-6%,-4%) scale(1); } 50% { transform: translate(7%,5%) scale(1.18); } 100% { transform: translate(-6%,-4%) scale(1); } }
@keyframes tr-sheen { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
.tr-row-in { animation: tr-fadeup .3s cubic-bezier(.2,.7,.3,1) both; }
.tr-urgent-spine { animation: tr-urgentglow 2.4s ease-in-out infinite; }
.tr-blob { position: absolute; border-radius: 9999px; filter: blur(46px); opacity: .2; will-change: transform; pointer-events: none; }
.tr-sheen { background-size: 200% 100%; animation: tr-sheen 7s linear infinite; }
@keyframes tr-slidein { from { transform: translateX(100%); } to { transform: none; } }
@keyframes tr-scrim { from { opacity: 0; } to { opacity: 1; } }
.tr-drawer { animation: tr-slidein .28s cubic-bezier(.16,1,.3,1) both; }
.tr-scrim { animation: tr-scrim .2s ease both; }
@media (prefers-reduced-motion: reduce) {
  .tr-row-in, .tr-urgent-spine, .tr-blob, .tr-sheen, .tr-drawer, .tr-scrim { animation: none !important; }
}
`;

function Panel({ subPath }: { subPath?: string }) {
  // persisted so switching tabs/threads returns you to the same mode, not "tasks"
  const [mode, setMode] = usePersistentState<Mode>("panel.mode", "tasks");
  const [selectedNote, setSelectedNote] = usePersistentState<string | null>("panel.selectedNote", null);
  // Deep link `…/tracker/task_xxx` opens that task's drawer on the board.
  const deepTaskId = subPath && subPath.startsWith("task_") ? subPath : null;
  const deepInitiativeId = subPath && subPath.startsWith("initiative_") ? subPath : null;
  const deepPracticeId = subPath && subPath.startsWith("practice_") ? subPath : null;
  useEffect(() => { if (deepTaskId) setMode("tasks"); }, [deepTaskId]);
  useEffect(() => { if (deepInitiativeId) setMode("initiatives"); }, [deepInitiativeId]);
  useEffect(() => { if (deepPracticeId) setMode("practice"); }, [deepPracticeId]);
  const tabs = <ModeTabs mode={mode} setMode={setMode} />;

  return (
    <div className="flex h-full flex-col">
      <style>{TRACKER_FX}</style>
      {/* live accent line */}
      <div
        className="tr-sheen h-[2px] shrink-0"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, var(--primary) 45%, var(--primary) 55%, transparent 100%)",
          opacity: 0.7,
        }}
      />
      <div className="min-h-0 flex-1">
      {mode === "tasks" && <KanbanView tabs={tabs} openTaskId={deepTaskId} />}
      {mode === "initiatives" && <InitiativesView tabs={tabs} openInitiativeId={deepInitiativeId} />}
      {mode === "practice" && <PracticeView tabs={tabs} openItemId={deepPracticeId} />}
      {mode === "notes" && (
        <NotesView tabs={tabs} selectedId={selectedNote} onSelect={setSelectedNote} />
      )}
      {mode === "library" && <LibraryView tabs={tabs} />}
      {mode === "graph" && (
        <GraphView
          tabs={tabs}
          onOpenNote={(id) => {
            setSelectedNote(id);
            setMode("notes");
          }}
          onOpenTask={() => setMode("tasks")}
        />
      )}
      </div>
    </div>
  );
}

/**
 * Thread right-sidebar panel: the tasks linked to this chat. Link/unlink
 * existing tasks; open one in Atlas. The same links show on the task itself.
 */
function ThreadTasksPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [all, setAll] = useState<Task[]>([]);

  const load = useCallback(async () => {
    try {
      const r = (await rpc.call("threadTasks", { threadId })) as { tasks: Task[] };
      setTasks(r.tasks);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [rpc, threadId]);
  useEffect(() => { void load(); }, [load]);
  useRealtime("tracker", () => void load());

  const openPicker = async () => {
    const next = !adding;
    setAdding(next);
    if (next) {
      try {
        const r = (await rpc.call("listTasks", { view: "all" })) as { tasks: Task[] };
        setAll(r.tasks);
      } catch { setAll([]); }
    }
  };
  const linkedIds = new Set(tasks.map((t) => t.id));
  const query = q.trim().toLowerCase();
  const candidates = all
    .filter((t) => !linkedIds.has(t.id))
    .filter((t) => !query || t.title.toLowerCase().includes(query) || t.tags.some((g) => g.includes(query)))
    .slice(0, 40);

  const link = async (taskId: string) => {
    try { await rpc.call("linkTaskThread", { taskId, threadId }); setAdding(false); setQ(""); await load(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const unlink = async (taskId: string) => {
    try { await rpc.call("unlinkTaskThread", { taskId, threadId }); await load(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-foreground">
      <style>{TRACKER_FX}</style>
      <div className="flex items-center gap-2">
        <Icon name="Target" className="size-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-semibold tracking-tight">Linked tasks</span>
        <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{tasks.length}</span>
        <button type="button" onClick={() => void openPicker()} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          <Icon name={adding ? "X" : "Plus"} className="size-3.5" aria-hidden /> {adding ? "Close" : "Link task"}
        </button>
      </div>

      {adding && (
        <div className="rounded-lg border border-border/60 bg-card p-1.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
            placeholder="Search tasks to link…"
            className="w-full bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <div className="mt-1 max-h-64 space-y-0.5 overflow-y-auto">
            {candidates.length === 0 ? (
              <p className="px-1.5 py-1 text-xs text-muted-foreground">No tasks found.</p>
            ) : (
              candidates.map((t) => {
                const col = COLUMNS.find((c) => c.id === t.stage);
                return (
                  <button key={t.id} type="button" onClick={() => void link(t.id)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted">
                    <Icon name={col?.icon ?? "Target"} className={cn("size-3.5 shrink-0", col?.tint)} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{t.seq}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <ThreadInitiativesSection threadId={threadId} />
        <div className="border-t border-border/50" />
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/60 px-3 py-8 text-center text-xs text-muted-foreground/70">
            No tasks linked to this chat yet.<br />Use “Link task”, or ask the agent to “link this thread to task &lt;n&gt;”.
          </div>
        ) : (
          tasks.map((t) => {
            const col = COLUMNS.find((c) => c.id === t.stage);
            return (
              <div key={t.id} className="group/lt rounded-xl border border-border/60 bg-card p-3">
                <div className="flex items-start gap-2">
                  <Icon name={col?.icon ?? "Target"} className={cn("mt-0.5 size-4 shrink-0", col?.tint)} aria-hidden />
                  <button type="button" onClick={() => nav.toPluginPanel("tracker", { subPath: t.id })} className="min-w-0 flex-1 text-left text-sm font-medium leading-snug hover:text-primary" title="Open in Atlas">
                    {t.title}
                  </button>
                  <button type="button" onClick={() => void unlink(t.id)} aria-label="Unlink" className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/lt:opacity-100">
                    <Icon name="X" className="size-3.5" aria-hidden />
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[11px] text-muted-foreground">
                  <span className="font-mono">#{t.seq}</span>
                  <span>· {col?.label ?? t.stage}</span>
                  {t.tags.slice(0, 4).map((g) => (
                    <span key={g} className="rounded bg-muted/60 px-1.5 py-0.5">#{g}</span>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Initiatives linked to this chat (compact section inside the thread panel). */
function ThreadInitiativesSection({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [items, setItems] = useState<Initiative[]>([]);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [all, setAll] = useState<Initiative[]>([]);

  const load = useCallback(async () => {
    try {
      const r = (await rpc.call("threadInitiatives", { threadId })) as { initiatives: Initiative[] };
      setItems(r.initiatives);
    } catch { /* ignore */ }
  }, [rpc, threadId]);
  useEffect(() => { void load(); }, [load]);
  useRealtime("tracker", () => void load());

  const openPicker = async () => {
    const next = !adding;
    setAdding(next);
    if (next) {
      try { const r = (await rpc.call("listInitiatives", {})) as { initiatives: Initiative[] }; setAll(r.initiatives); }
      catch { setAll([]); }
    }
  };
  const have = new Set(items.map((i) => i.id));
  const query = q.trim().toLowerCase();
  const candidates = all.filter((i) => !have.has(i.id)).filter((i) => !query || i.title.toLowerCase().includes(query)).slice(0, 40);
  const link = async (id: string) => {
    try { await rpc.call("linkInitiativeThread", { initiativeId: id, threadId }); setAdding(false); setQ(""); await load(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const unlink = async (id: string) => {
    try { await rpc.call("unlinkInitiativeThread", { initiativeId: id, threadId }); await load(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <Icon name="Zap" className="size-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-semibold tracking-tight">Initiatives</span>
        <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{items.length}</span>
        <button type="button" onClick={() => void openPicker()} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          <Icon name={adding ? "X" : "Plus"} className="size-3.5" aria-hidden /> {adding ? "Close" : "Link"}
        </button>
      </div>
      {adding && (
        <div className="mb-2 rounded-lg border border-border/60 bg-card p-1.5">
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Search initiatives…" className="w-full bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground/60" />
          <div className="mt-1 max-h-52 space-y-0.5 overflow-y-auto">
            {candidates.length === 0 ? (
              <p className="px-1.5 py-1 text-xs text-muted-foreground">No initiatives found.</p>
            ) : (
              candidates.map((i) => {
                const col = initiativeCol(i.status);
                return (
                  <button key={i.id} type="button" onClick={() => void link(i.id)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted">
                    <Icon name={col.icon} className={cn("size-3.5 shrink-0", col.tint)} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{i.title}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{i.seq}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
      {items.length === 0 ? (
        <p className="px-0.5 text-xs text-muted-foreground/70">No initiatives linked to this chat.</p>
      ) : (
        <div className="space-y-2">
          {items.map((i) => {
            const col = initiativeCol(i.status);
            return (
              <div key={i.id} className="group/li rounded-xl border border-border/60 bg-card p-3">
                <div className="flex items-start gap-2">
                  <Icon name={col.icon} className={cn("mt-0.5 size-4 shrink-0", col.tint)} aria-hidden />
                  <button type="button" onClick={() => nav.toPluginPanel("tracker", { subPath: i.id })} className="min-w-0 flex-1 text-left text-sm font-medium leading-snug hover:text-primary" title="Open in Atlas">
                    {i.title}
                  </button>
                  <button type="button" onClick={() => void unlink(i.id)} aria-label="Unlink" className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/li:opacity-100">
                    <Icon name="X" className="size-3.5" aria-hidden />
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[11px] text-muted-foreground">
                  <span className="font-mono">#{i.seq}</span>
                  <span>· {col.label}</span>
                  {i.taskCount > 0 && <span>· {i.doneCount}/{i.taskCount} tasks</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "tracker",
    title: "Atlas",
    icon: "ListTodo",
    path: "tracker",
    component: Panel,
  });
  app.slots.threadPanelAction({
    id: "atlas-links",
    title: "Atlas",
    icon: "ListTodo",
    component: ({ threadId }) => <ThreadTasksPanel threadId={threadId} />,
  });
});
