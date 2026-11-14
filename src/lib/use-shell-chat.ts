import { useForm } from "@mantine/form";
import { useListState } from "@mantine/hooks";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { aiResponseSchema } from "@/src/lib/contracts";
import { checkAi } from "@/src/lib/generated/cure";

// Conversations stay in memory and are never added to the clinical offline queue.
export function useShellChat(owner: string) {
  const form = useForm({ initialValues: { message: "" } });
  const [messages, actions] = useListState<{ role: "user" | "assistant"; content: string }>([]);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const send = useMutation({
    mutationKey: ["ai-chat", owner],
    retry: false,
    networkMode: "always",
    gcTime: 0,
    mutationFn: async (content: string) => {
      if (!content.trim() || content.length > 8000 || messages.length >= 30)
        throw new Error("INVALID_INPUT");
      const next = [...messages, { role: "user" as const, content }];
      const controller = new AbortController();
      request.current = controller;
      const result = aiResponseSchema.parse(
        await checkAi(
          {
            provider: "gigachat",
            model: "GigaChat",
            messages: next,
          },
          { signal: controller.signal },
        ),
      );
      return [...next, { role: "assistant" as const, content: result.text }];
    },
    onSuccess: (next) => {
      actions.setState(next);
      form.reset();
    },
  });
  return {
    form,
    messages,
    send,
    clear: () => {
      actions.setState([]);
      send.reset();
    },
  };
}
