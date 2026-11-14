import type { LibraryEntry, LibraryRow } from "@/src/lib/library-model";
import type { MedicalRecord } from "@/src/lib/medical-catalog";

export const emptyLibraryEntry: LibraryEntry = {
  title: "",
  doi: "",
  pmid: "",
  url: "",
  citation: "",
  authors: "",
  year: null,
  collection: "",
  tags: [],
  notes: "",
  status: "toRead",
  exclusionReason: "",
  source: "manual",
  fetchedAt: null,
};
export function publicationEntry(record: MedicalRecord, previous?: LibraryEntry): LibraryEntry {
  if (record.source !== "pubmed" || !/^\d+$/.test(record.sourceId))
    throw new Error("INVALID_LIBRARY");
  const fetchedAt = Date.parse(record.fetchedAt);
  return {
    ...(previous ?? emptyLibraryEntry),
    title: record.title,
    pmid: record.sourceId,
    url: `https://pubmed.ncbi.nlm.nih.gov/${record.sourceId}/`,
    doi: record.bibliography?.doi || previous?.doi || "",
    authors: record.bibliography?.authors.join("; ") || previous?.authors || "",
    year: record.bibliography?.year ?? previous?.year ?? null,
    citation: record.description || previous?.citation || "",
    source: "pubmed",
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
  };
}
export function matchingPublication(rows: readonly LibraryRow[], record: MedicalRecord) {
  const doi = record.bibliography?.doi.toLowerCase();
  return rows.find(
    (row) =>
      !row.deleted &&
      row.entry &&
      ((row.entry.pmid && row.entry.pmid === record.sourceId) ||
        (doi && row.entry.doi.toLowerCase() === doi)),
  );
}
export function filterLibrary(
  rows: readonly LibraryRow[],
  filters: { query: string; status: string; collection: string | null; tags: readonly string[] },
) {
  const needle = filters.query.normalize("NFKC").trim().toLowerCase();
  return rows
    .filter(
      (row) =>
        !row.deleted &&
        row.entry &&
        (filters.status === "all" || row.entry.status === filters.status) &&
        (!filters.collection || row.entry.collection === filters.collection) &&
        filters.tags.every((tag) => row.entry!.tags.includes(tag)) &&
        `${row.entry.title} ${row.entry.authors} ${row.entry.doi} ${row.entry.pmid} ${row.entry.citation} ${row.entry.notes} ${row.entry.collection} ${row.entry.tags.join(" ")}`
          .normalize("NFKC")
          .toLowerCase()
          .includes(needle),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.clientId.localeCompare(b.clientId));
}
