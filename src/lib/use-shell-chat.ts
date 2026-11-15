import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useListState } from "@mantine/hooks";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { createActionRegistry } from "@/src/lib/action-registry";
import type { AssistantActionPayload } from "@/src/lib/chat-actions";
import {
  buildActionProtocolPrefix,
  parseAssistantAction,
  protocolMessages,
} from "@/src/lib/chat-actions";
import { aiResponseSchema } from "@/src/lib/contracts";
import { checkAi } from "@/src/lib/generated/cure";
import { useActionContext } from "@/src/lib/use-action-context";

export type ChatCard = {
  action: string;
  input: Record<string, unknown>;
  status: "pending" | "executed" | "failed" | "cancelled";
  provider?: string;
  result?: string;
  error?: string;
};
export type ShellMessage = {
  role: "user" | "assistant";
  content: string;
  card?: ChatCard;
};

const registry = createActionRegistry();
const writeActions = new Set(
  registry
    .list()
    .filter(({ kind }) => kind === "write")
    .map(({ id }) => id),
);

// Conversations stay in memory and are never added to the clinical offline queue.
export function useShellChat(owner: string) {
  const { t } = useLingui();
  const actionContext = useActionContext();
  const form = useForm({ initialValues: { message: "" } });
  const [messages, actions] = useListState<ShellMessage>([]);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const execute = useMutation({
    mutationKey: ["ai-chat-action", owner],
    retry: false,
    networkMode: "always",
    gcTime: 0,
    mutationFn: async (input: { payload: AssistantActionPayload; provider: string }) => {
      const context = actionContext.getContext();
      const output = await registry.run(
        context,
        { kind: "assistant", interface: "chat", userId: owner, model: input.provider },
        input.payload.action,
        input.payload.input,
      );
      return JSON.stringify(output, null, 2);
    },
  });
  const updateCard = (index: number, card: ChatCard) =>
    actions.setState((current) =>
      current.map((message, position) => (position === index ? { ...message, card } : message)),
    );
  const appendCard = (card: ChatCard, content: string) =>
    actions.setState((current) => [...current, { role: "assistant" as const, content, card }]);
  const runPayload = (payload: AssistantActionPayload, provider: string, index?: number) => {
    if (!actionContext.ready) {
      const card: ChatCard = {
        action: payload.action,
        input: payload.input,
        status: "failed",
        error: "WORKSPACE_LOCKED",
      };
      const content = t`Действие недоступно: рабочее пространство закрыто.`;
      if (index === undefined) appendCard(card, content);
      else updateCard(index, card);
      return;
    }
    execute.mutate(
      { payload, provider },
      {
        onSuccess: (result) => {
          const card: ChatCard = {
            action: payload.action,
            input: payload.input,
            status: "executed",
            result,
          };
          const content = t`Действие ${payload.action} выполнено.`;
          if (index === undefined) appendCard(card, content);
          else updateCard(index, card);
        },
        onError: (error) => {
          const code = error instanceof Error ? error.message : "ACTION_FAILED";
          const card: ChatCard = {
            action: payload.action,
            input: payload.input,
            status: "failed",
            error: code,
          };
          const content = t`Действие ${payload.action} не выполнено: ${code}.`;
          if (index === undefined) appendCard(card, content);
          else updateCard(index, card);
        },
      },
    );
  };
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
            messages: protocolMessages(
              next,
              buildActionProtocolPrefix(registry, actionContext.ready),
            ),
          },
          { signal: controller.signal },
        ),
      );
      return { next, result };
    },
    onSuccess: ({ next, result }) => {
      actions.setState(next);
      const payload = parseAssistantAction(result.text);
      if (!payload) {
        actions.setState((current) => [
          ...current,
          { role: "assistant" as const, content: result.text },
        ]);
      } else if (writeActions.has(payload.action) && actionContext.ready) {
        appendCard(
          {
            action: payload.action,
            input: payload.input,
            status: "pending",
            provider: result.provider,
          },
          t`Действие ${payload.action} требует подтверждения.`,
        );
      } else {
        runPayload(payload, result.provider);
      }
      form.reset();
    },
  });
  return {
    form,
    messages,
    send,
    execute,
    confirmAction: (index: number) => {
      const card = messages[index]?.card;
      if (!card || card.status !== "pending") return;
      runPayload({ action: card.action, input: card.input }, card.provider ?? "GigaChat", index);
    },
    cancelAction: (index: number) => {
      const card = messages[index]?.card;
      if (!card || card.status !== "pending") return;
      updateCard(index, { ...card, status: "cancelled" });
    },
    clear: () => {
      actions.setState([]);
      send.reset();
    },
  };
}
