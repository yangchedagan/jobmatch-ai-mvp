const DEFAULT_BASE_URL = () => process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = () => process.env.QWEN_MODEL || "qwen-plus";
const DEFAULT_TIMEOUT_MS = () => Number(process.env.QWEN_TIMEOUT_MS || 20000);
const DEFAULT_JSON_RETRIES = () => Number(process.env.QWEN_JSON_RETRIES || 3);

export function isQwenConfigured(options = {}) {
  return Boolean(options.apiKey || process.env.QWEN_API_KEY);
}

export function qwenModelName() {
  return DEFAULT_MODEL();
}

export async function chatCompletion({ messages, tools, toolChoice, jsonMode = false, maxTokens = 1024, temperature = 0.2, timeoutMs, apiKey } = {}) {
  const key = apiKey || process.env.QWEN_API_KEY;
  if (!key) throw new Error("QWEN_API_KEY is not configured.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(timeoutMs || DEFAULT_TIMEOUT_MS()));
  try {
    const response = await fetch(`${DEFAULT_BASE_URL().replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL(),
        messages,
        ...(Array.isArray(tools) && tools.length ? { tools, tool_choice: toolChoice || "auto" } : {}),
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload.error?.message || payload.message || response.statusText;
      throw new Error(`Qwen API ${response.status}: ${detail}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractAssistantMessage(payload) {
  return payload?.choices?.[0]?.message || {};
}

export function extractAssistantContent(payload) {
  const message = extractAssistantMessage(payload);
  const content = Array.isArray(message.content) ? message.content.map((part) => part.text || part.content || "").join("") : message.content;
  return String(content || "").trim();
}

export function extractToolCalls(payload) {
  const message = extractAssistantMessage(payload);
  return Array.isArray(message.tool_calls) ? message.tool_calls : [];
}

export async function requestQwenJson({ system, user, example, maxTokens = 900, timeoutMs } = {}) {
  const attempts = Math.max(1, DEFAULT_JSON_RETRIES());
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const payload = await chatCompletion({
        messages: [
          { role: "system", content: buildAttemptSystemPrompt(system, example, attempt) },
          { role: "user", content: user },
        ],
        maxTokens,
        timeoutMs,
        jsonMode: attempt < attempts,
      });
      const content = extractAssistantContent(payload);
      if (!content) {
        lastError = new Error(`Qwen API returned an empty message on attempt ${attempt}.`);
        continue;
      }
      return parseJsonContent(content);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Qwen API returned an empty message.");
}

function buildAttemptSystemPrompt(system, example, attempt) {
  const keys = Object.keys(example || {}).join(", ");
  const suffix =
    attempt === 1
      ? ""
      : ` The previous json attempt produced empty or invalid content. Output a non-empty json object now. Required keys: ${keys}. Do not output markdown, explanations, or whitespace before the json.`;
  return `${system}${suffix}`;
}

export function parseJsonContent(content) {
  const text = String(content || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse(fenced || text);
}
