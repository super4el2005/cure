import "@tanstack/react-start/server-only";
import type { AiInput } from "@/src/lib/ai-providers";
import { aiInputSchema } from "@/src/lib/contracts";
import { classifyAiError } from "@/src/server/ai-error";
import { generateByok } from "@/src/server/byok";
import { generateGigaChat } from "@/src/server/gigachat";

function failure(code: string, status: number) {
  return Response.json(
    { error: code },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function handleAiChat(
  request: Request,
  authenticate: () => Promise<boolean>,
  generate = async (req: Request, input: AiInput) =>
    input.provider === "gigachat" ? generateGigaChat(input) : generateByok(req, input),
) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return failure("FORBIDDEN_ORIGIN", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return failure("INVALID_CONTENT_TYPE", 415);
  try {
    if (!(await authenticate())) return failure("UNAUTHENTICATED", 401);
  } catch {
    return failure("AUTH_UNAVAILABLE", 503);
  }
  let input: AiInput;
  try {
    const text = await request.text();
    if (text.length > 64_000) return failure("REQUEST_TOO_LARGE", 413);
    const parsed = aiInputSchema.safeParse(JSON.parse(text));
    if (!parsed.success)
      return failure(
        parsed.error.issues.some((issue) => issue.path[0] === "model")
          ? "INVALID_MODEL"
          : "INVALID_REQUEST",
        400,
      );
    input = parsed.data;
  } catch {
    return failure("INVALID_REQUEST", 400);
  }
  try {
    const text = await generate(request, input);
    return Response.json(
      { text, provider: input.provider },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const code = classifyAiError(error);
    return failure(code, 503);
  }
}
