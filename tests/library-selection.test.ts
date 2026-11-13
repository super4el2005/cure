import { describe, expect, it } from "@rstest/core";

import { medicalSearchSchema } from "@/src/lib/contracts";
import type { LibraryEntry, LibraryRow } from "@/src/lib/library-model";
import {
  emptyLibraryEntry,
  filterLibrary,
  matchingPublication,
  publicationEntry,
} from "@/src/lib/library-selection";
import { medicalSearchRequest } from "@/src/lib/medical-catalog";
import type { MedicalRecord } from "@/src/lib/medical-catalog";

const paper: MedicalRecord = {
  id: "pubmed:123",
  source: "pubmed",
  sourceId: "123",
  title: "Updated title",
  description: "Journal 2026",
  code: "PMID:123",
  url: "https://pubmed.ncbi.nlm.nih.gov/123/",
  dataLanguage: "und",
  version: "2026",
  fetchedAt: "2026-11-14T00:00:00Z",
  country: "",
  latitude: null,
  longitude: null,
  bibliography: {
    doi: "10.1234/example",
    authors: ["Author One", "Author Two"],
    year: 2026,
    journal: "Journal",
  },
};
const previous: LibraryEntry = {
  ...emptyLibraryEntry,
  title: "Original title",
  url: paper.url,
  pmid: "123",
  doi: "10.1234/example",
  authors: "Earlier author",
  notes: "Private user decision",
  collection: "Evidence",
  tags: ["trial"],
  status: "excluded",
  exclusionReason: "Wrong population",
};
const row: LibraryRow = {
  clientId: crypto.randomUUID(),
  writeId: crypto.randomUUID(),
  revision: 1,
  deleted: false,
  entry: previous,
  createdAt: 1,
  updatedAt: 1,
};
describe("publication review and personal filters", () => {
  it("updates bibliographic drafts while retaining personal appraisal and avoiding duplicate PMID/DOI imports", () => {
    const draft = publicationEntry(paper, previous);
    expect(draft).toMatchObject({
      title: "Updated title",
      authors: "Author One; Author Two",
      year: 2026,
      source: "pubmed",
      notes: previous.notes,
      collection: previous.collection,
      tags: previous.tags,
      status: "excluded",
      exclusionReason: "Wrong population",
    });
    expect(previous.title).toBe("Original title");
    expect(matchingPublication([row], paper)?.clientId).toBe(row.clientId);
    expect(
      matchingPublication([{ ...row, entry: { ...previous, pmid: "" } }], paper)?.clientId,
    ).toBe(row.clientId);
    expect(matchingPublication([{ ...row, deleted: true, entry: null }], paper)).toBeUndefined();
    const { bibliography: _bibliography, ...older } = paper;
    expect(publicationEntry(older, previous).authors).toBe(previous.authors);
    expect(publicationEntry(older, previous).doi).toBe(previous.doi);
  });
  it("combines local note search, reading status, collections and all selected tags", () => {
    const all = {
      query: "private USER",
      status: "excluded",
      collection: "Evidence",
      tags: ["trial"],
    };
    expect(filterLibrary([row], all)).toEqual([row]);
    expect(filterLibrary([row], { ...all, tags: ["trial", "missing"] })).toEqual([]);
    expect(filterLibrary([row], { ...all, status: "reading" })).toEqual([]);
    expect(
      filterLibrary([{ ...row, entry: null, deleted: true }], {
        ...all,
        query: "",
        status: "all",
        collection: null,
        tags: [],
      }),
    ).toEqual([]);
  });
});

it("rejects offsets beyond the provider window and preserves legacy PubMed requests", () => {
  expect(medicalSearchSchema.safeParse({ source: "pubmed", query: "asthma" }).success).toBe(true);
  expect(
    medicalSearchSchema.safeParse({ source: "pubmed", query: "asthma", offset: 9980 }).success,
  ).toBe(true);
  for (const offset of [-1, 9981, 0.5])
    expect(
      medicalSearchSchema.safeParse({ source: "pubmed", query: "asthma", offset }).success,
    ).toBe(false);
});

it("normalizes legacy and paged PubMed requests consistently for generated clients and result matching", () => {
  const legacy = medicalSearchSchema.parse({ source: "pubmed", query: " asthma " });
  const wire = medicalSearchRequest(legacy);
  expect(wire).toEqual({ source: "pubmed", query: "asthma", offset: 0 });
  expect(medicalSearchRequest(medicalSearchSchema.parse(wire))).toEqual(wire);
  expect(medicalSearchRequest(medicalSearchSchema.parse({ ...wire, offset: 20 }))).toEqual({
    ...wire,
    offset: 20,
  });
});
