import { useQuery } from "@tanstack/react-query";
import { useConvex } from "convex/react";

import { api } from "@/convex/_generated/api";
import { recruitmentTotals } from "@/src/lib/recruitment-journal";

// Server-side aggregate only: the journal requires network and an active
// project membership. Non-members get null instead of an error so the page
// can show a dedicated notice rather than a failure.
export function useRecruitmentJournal(
  projectId: string,
  userId: string | undefined,
  online: boolean,
) {
  const convex = useConvex();
  const centers = useQuery({
    queryKey: ["recruitment-centers", projectId, userId],
    enabled: Boolean(userId) && online,
    gcTime: 0,
    networkMode: "always",
    retry: false,
    queryFn: async () => {
      try {
        return await convex.query(api.recruitment.centers, {
          projectClientId: projectId,
          actorId: userId!,
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("ACCESS_DENIED")) return null;
        throw error;
      }
    },
  });
  const rows = centers.data ?? [];
  return { centers, rows, totals: recruitmentTotals(rows) };
}
