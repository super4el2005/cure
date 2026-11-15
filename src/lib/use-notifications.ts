import { useQuery } from "@tanstack/react-query";
import { useConvex } from "convex/react";

import { api } from "@/convex/_generated/api";

// Online-only derived feed: the server recomputes pointers to open work on
// every read, so nothing is cached for offline use or stored locally.
export function useNotifications(userId: string | undefined, online: boolean) {
  const convex = useConvex();
  const feed = useQuery({
    queryKey: ["notifications", userId],
    enabled: Boolean(userId) && online,
    gcTime: 0,
    networkMode: "always",
    retry: false,
    refetchInterval: 30000,
    queryFn: () => convex.query(api.notifications.feed, { actorId: userId! }),
  });
  return { feed, items: feed.data ?? [] };
}
