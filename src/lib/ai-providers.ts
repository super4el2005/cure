import { defineByokProvider } from "@tanstack/ai/byok";
import type { z } from "zod";

import type { aiInputSchema } from "@/src/lib/contracts";

export const aiProviders = [
  { id: "gigachat", label: "GigaChat", model: "GigaChat" },
  { id: "openai", label: "OpenAI", model: "gpt-4.1-mini" },
  { id: "anthropic", label: "Anthropic", model: "claude-sonnet-4-5" },
  { id: "gemini", label: "Google Gemini", model: "gemini-2.5-flash" },
  { id: "openrouter", label: "OpenRouter", model: "openai/gpt-4.1-mini" },
  { id: "deepseek", label: "DeepSeek", model: "deepseek-chat" },
  { id: "groq", label: "Groq", model: "llama-3.3-70b-versatile" },
  { id: "custom", label: "OpenAI-compatible API", model: "" },
] as const;
export type AiProvider = (typeof aiProviders)[number]["id"];
export const byokProviders = aiProviders
  .filter((provider) => provider.id !== "gigachat")
  .map(({ id, label }) => defineByokProvider({ id, label }));
export function isAiProvider(value: unknown): value is AiProvider {
  return aiProviders.some((provider) => provider.id === value);
}
export type AiInput = z.infer<typeof aiInputSchema>;
