// Twenty Two AI — Supabase Edge Function
// Set OPENAI_API_KEY in Supabase > Edge Functions > Secrets.
// Optional: set OPENAI_MODEL (defaults to gpt-6-luna).
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://alievali79804-ai.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const allowedOrigin = "https://alievali79804-ai.github.io";
const encoder = new TextEncoder();
const recentCalls = new Map<string, number[]>();

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getPublishableKey(): string {
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw);
      if (keys.default) return keys.default;
    } catch { /* try legacy fallback */ }
  }
  return Deno.env.get("SUPABASE_ANON_KEY") || "";
}

function allowRate(ip: string): boolean {
  const now = Date.now();
  const recent = (recentCalls.get(ip) || []).filter(t => now - t < 60_000);
  if (recent.length >= 8) return false;
  recent.push(now);
  recentCalls.set(ip, recent);
  return true;
}

function extractText(data: any): string {
  if (typeof data.output_text === "string") return data.output_text;
  const parts: string[] = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin === allowedOrigin ? allowedOrigin : "null" } });
  }
  if (origin && origin !== allowedOrigin) return json({ error: "Origin is not allowed." }, 403);
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const expectedKey = getPublishableKey();
  const suppliedKey = req.headers.get("apikey") || "";
  if (!expectedKey || suppliedKey !== expectedKey) return json({ error: "Не удалось проверить подключение сайта." }, 401);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!allowRate(ip)) return json({ error: "Слишком много сообщений подряд. Подожди минуту и попробуй снова." }, 429);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "ИИ ещё не настроен: на сервере не добавлен ключ модели." }, 503);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Некорректный запрос." }, 400); }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-8) : [];
  if (!messages.length || messages.some((m: any) => !["user", "assistant"].includes(m.role) || typeof m.content !== "string")) {
    return json({ error: "Проверь текст сообщения и попробуй ещё раз." }, 400);
  }
  const safeMessages = messages.map((m: any) => ({
    role: m.role,
    content: m.content.slice(0, 1200),
  }));
  const catalogue = Array.isArray(body.catalogue) ? body.catalogue.slice(0, 5) : [];
  const compactCatalogue = catalogue.map((p: any) => ({
    id: String(p.id || "").slice(0, 40),
    title: String(p.title || "").slice(0, 120),
    description: String(p.description || "").slice(0, 300),
    steps: Array.isArray(p.steps) ? p.steps.slice(0, 6).map((st: any) => ({
      number: st.number, title: String(st.title || "").slice(0, 120),
      whatToDo: String(st.whatToDo || "").slice(0, 350),
      whereToClick: String(st.whereToClick || "").slice(0, 250),
    })) : [],
    warning: String(p.warning || "").slice(0, 300),
  }));

  const instructions = `Ты — Twenty Two AI, помощник сайта Twenty Two Fix.
Главная ценность проекта: «Покажем не только что делать, но и куда нажимать».
Всегда отвечай на русском простым, спокойным языком, без сложного жаргона.
Сначала уточняй важные детали, если без них можно дать неправильную инструкцию.
Давай короткие нумерованные шаги. В каждом шаге отдельно указывай действие и точное место/кнопку, куда нажать.
Используй каталог сайта ниже как основной источник. Не выдумывай названия кнопок, пункты меню, изображения или результаты диагностики.
Если в каталоге есть подходящая инструкция, предложи её открыть и добавь её id в instructionIds.
Если подходящего материала нет, честно скажи об этом и задай один уточняющий вопрос.
Не утверждай, что приложил настоящий скриншот: на первом этапе можно направить пользователя к пошаговой инструкции сайта. Не проси пароли, коды подтверждения или личные данные.
Не советуй отключать защиту Windows, удалять неизвестные системные файлы или запускать команды, смысл которых пользователь не понимает.
Ответь строго одним JSON-объектом без Markdown и без текста до/после:
{"reply":"текст ответа пользователю","instructionIds":["id_из_каталога"]}
Поле instructionIds — массив из 0–3 существующих id.`;

  const model = Deno.env.get("OPENAI_MODEL") || "gpt-6-luna";
  try {
    const apiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        instructions,
        input: [
          { role: "user", content: "Каталог инструкций Twenty Two Fix (используй только подходящие пункты):\n" + JSON.stringify(compactCatalogue) },
          ...safeMessages,
        ],
        max_output_tokens: 700,
        store: false,
      }),
    });
    const result = await apiResponse.json();
    if (!apiResponse.ok) {
      console.error("Model API error", apiResponse.status, result?.error?.type || "unknown");
      return json({ error: "Сервис ИИ временно недоступен. Попробуй позже." }, 502);
    }
    const raw = extractText(result);
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch {
      parsed = { reply: raw, instructionIds: [] };
    }
    const reply = typeof parsed.reply === "string" ? parsed.reply.slice(0, 3500) : "Не получилось сформировать ответ. Попробуй уточнить проблему.";
    const validIds = new Set(compactCatalogue.map((p: any) => p.id));
    const instructionIds = Array.isArray(parsed.instructionIds)
      ? parsed.instructionIds.filter((id: any) => typeof id === "string" && validIds.has(id)).slice(0, 3)
      : [];
    return json({ reply, instructionIds });
  } catch (error) {
    console.error("Twenty Two AI request failed", error);
    return json({ error: "Не удалось связаться с сервисом ИИ. Попробуй ещё раз позже." }, 502);
  }
});
