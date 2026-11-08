import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import {
  convexCollectionOptions,
  convexPaginatedCollectionOptions,
} from "@tanstack/convex-db-collection";
import { createCollection } from "@tanstack/db";
import type { ConvexReactClient } from "convex/react";

import { api } from "@/convex/_generated/api";

// Only public, verified directory data. Patient records never enter this database.
export async function openPublicDirectory(
  client: ConvexReactClient,
  signal?: AbortSignal,
  researchId?: string,
) {
  const name = "cure-public-directory-v1";
  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName: name,
    ...(signal ? { signal } : {}),
  });
  const coordinator = new BrowserCollectionCoordinator({ dbName: name });
  const persistence = createBrowserWASQLitePersistence({
    database,
    coordinator,
    schemaMismatchPolicy: "throw",
  });
  const specialists = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: "cure-public-specialists-v1",
        client,
        query: api.profiles.directory,
        queryArgs: {},
        getKey: (row) => row.id,
      }),
      persistence,
      schemaVersion: 1,
    }),
  );
  const organizations = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: "cure-public-organizations-v1",
        client,
        query: api.organizations.directory,
        queryArgs: {},
        getKey: (row) => row.id,
      }),
      persistence,
      schemaVersion: 1,
    }),
  );
  const research = createCollection(
    persistedCollectionOptions({
      ...convexPaginatedCollectionOptions({
        id: "cure-public-research-v1",
        client,
        query: api.projects.publicPage,
        queryArgs: {},
        getKey: (row) => row.id,
        syncMode: "on-demand",
        queryOrder: { field: "createdAt", direction: "desc" },
        pageSize: 50,
        maxRows: Number.MAX_SAFE_INTEGER,
      }),
      persistence,
      schemaVersion: 1,
    }),
  );
  const researchDetails = researchId
    ? createCollection(
        persistedCollectionOptions({
          ...convexCollectionOptions({
            id: `cure-public-research-detail-v1:${researchId}`,
            client,
            query: api.projects.publicDetails,
            queryArgs: { clientId: researchId },
            select: (value) => (value ? [value] : []),
            getKey: (row) => row.id,
          }),
          persistence,
          schemaVersion: 1,
        }),
      )
    : undefined;
  return {
    specialists,
    organizations,
    research,
    researchDetails,
    async close() {
      try {
        await Promise.all([
          specialists.cleanup(),
          organizations.cleanup(),
          research.cleanup(),
          researchDetails?.cleanup(),
        ]);
      } finally {
        coordinator.dispose();
        await database.close?.();
      }
    },
  };
}
