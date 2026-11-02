const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-20b";
const MAX_BODY_BYTES = 120_000;
const MAX_QUESTION_CHARS = 4_000;
const MAX_CONTEXT_ITEMS = 8;
const MAX_CONTEXT_CHARS = 8_000;
const MAX_TOTAL_CONTEXT_CHARS = 32_000;

const SYSTEM_PROMPT = `Answer the user's question using only the provided document context.
If the context does not contain the answer, say that the uploaded documents do not contain enough information.
Be concise and accurate. Do not invent facts or cite information outside the context.`;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function buildContext(context) {
  if (!Array.isArray(context)) return "";

  let total = 0;
  const blocks = [];

  for (const item of context.slice(0, MAX_CONTEXT_ITEMS)) {
    const text = cleanText(item?.text, MAX_CONTEXT_CHARS);
    if (!text) continue;

    const source = cleanText(item?.source, 200);
    const block = source ? `[Source: ${source}]\n${text}` : text;

    if (total + block.length > MAX_TOTAL_CONTEXT_CHARS) break;
    total += block.length;
    blocks.push(block);
  }

  return blocks.join("\n\n---\n\n");
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY is not configured");
    return json(500, { error: "The server is missing its Groq API key." });
  }

  let payload;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json(413, { error: "The request is too large." });
    }
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: "Invalid JSON request body." });
  }

  const question = cleanText(payload?.question, MAX_QUESTION_CHARS);
  if (!question) {
    return json(400, { error: "A question is required." });
  }

  const context = buildContext(payload?.context);
  if (!context) {
    return json(400, {
      error: "Document context is required. Submit a document before asking questions.",
    });
  }

  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;

  try {
    const upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_completion_tokens: 1024,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Document context:\n\n${context}\n\nQuestion: ${question}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      console.error("Groq request failed", upstream.status, data);
      const detail =
        typeof data?.error?.message === "string"
          ? data.error.message.slice(0, 500)
          : "The language model request failed.";
      return json(upstream.status === 429 ? 429 : 502, { error: detail });
    }

    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) {
      return json(502, { error: "The language model returned an empty response." });
    }

    return json(200, {
      answer: answer.trim(),
      model: data?.model || model,
    });
  } catch (error) {
    console.error("Chat request error", error);
    if (error?.name === "TimeoutError") {
      return json(504, { error: "The language model request timed out." });
    }
    return json(502, { error: "Could not reach the language model." });
  }
}

export const config = {
  path: "/api/chat",
  rateLimit: {
    action: "rate_limit",
    aggregateBy: ["ip", "domain"],
    windowSize: 60,
    windowLimit: 20,
  },
};
