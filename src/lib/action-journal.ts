import type { ActionJournalEntry } from "@/src/lib/action-registry";

// In-memory ring buffer of action invocations for the current workspace
// session. Persistence and the server-side AI audit ship with the chat
// and WebMCP entry points; this journal never holds patient rows,
// identifiers or free-text input — only invocation metadata.
export function createActionJournal(limit = 200) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("INVALID_JOURNAL_LIMIT");
  const entries: ActionJournalEntry[] = [];
  return {
    record(entry: ActionJournalEntry) {
      entries.push(entry);
      if (entries.length > limit) entries.shift();
    },
    list: () => [...entries],
  };
}
