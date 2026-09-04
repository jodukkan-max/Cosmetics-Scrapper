// Supabase Edge Function: proxies DeepSeek chat completions.
// The DeepSeek API key lives ONLY in the function secret `DEEPSEEK_API_KEY`
// (never in the extension). No auth — open proxy (see deploy note below).
//
// Deploy:
//   supabase functions deploy deepseek
//   supabase secrets set DEEPSEEK_API_KEY=sk-...
//
// NOTE: this endpoint is open to anonymous callers. To limit abuse, add a rate
// limit in the dashboard (Edge Functions → deepseek → Settings) or protect it
// with a JWT check again if you later re-enable Supabase Auth.

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-v4-flash";

// Caps that keep this proxy inside the Edge Runtime's hard limits (2s CPU /
// 250MB memory). A scraper function is a few KB, so 8k output tokens is ample;
// capping it prevents a runaway/reasoning response from being buffered whole
// and keeps generation fast enough to finish under the 120s client timeout.
const MAX_OUTPUT_TOKENS = 8192;
const MAX_JSON_TOKENS = 1024;
// thinking ON: reserve a budget large enough for a focused phase task (the model
// reasons for ~3-4k tokens and emits ~3-4k tokens of scraper code) but small
// enough to finish well under the 120s client / 150s wall-clock limit. 16k made
// a single call reason for so long it timed out. The generation is split into
// two phases, so no single call needs more than this.
const MAX_THINK_TOKENS = 8192;
const MAX_BODY_BYTES = 8_000_000; // hard guard before we even try to parse

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const key = Deno.env.get("DEEPSEEK_API_KEY");
    if (!key) return json({ error: "DEEPSEEK_API_KEY not set" }, 500);

    const payload = await req.json();
    const messages = payload?.messages;
    const wantJson = !!payload?.json;
    const wantThinking = !!payload?.thinking;
    if (!Array.isArray(messages)) return json({ error: "messages is required" }, 400);

    const body: Record<string, unknown> = {
      model: MODEL,
      messages,
      stream: false,
      max_tokens: wantJson
        ? MAX_JSON_TOKENS
        : wantThinking
          ? MAX_THINK_TOKENS
          : MAX_OUTPUT_TOKENS,
      // deepseek-v4-flash is a reasoning model. For heavy generation (a scraper
      // written from scratch) we allow the caller to turn thinking ON so the
      // model can actually reason about the page before coding — with a larger
      // token budget so the chain-of-thought can't starve the answer. For fast
      // paths (classification, small chat fixes) thinking stays OFF for speed.
      thinking: wantThinking ? { type: "enabled" } : { type: "disabled" },
    };
    if (wantJson) body.response_format = { type: "json_object" };

    const r = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

    // Read as text first so a pathological upstream body can't OOM the isolate
    // inside `r.json()`; parse only if it's within a sane size.
    const raw = await r.text();
    if (!r.ok) {
      let upstream = `DeepSeek HTTP ${r.status}`;
      if (raw.length < MAX_BODY_BYTES) {
        try { upstream = JSON.parse(raw)?.error?.message || upstream; } catch { /* keep default */ }
      }
      return json({ error: upstream }, r.status);
    }
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: "upstream response too large" }, 502);
    }

    let data: any = null;
    try { data = JSON.parse(raw); } catch {
      return json({ error: "invalid upstream response" }, 502);
    }

    const msg = data?.choices?.[0]?.message || {};
    let content = typeof msg.content === "string" ? msg.content : "";
    // Pass the model's chain-of-thought through (truncated) so the extension can
    // show "what the agent is thinking", but never forward an unbounded blob.
    const reasoning = typeof msg.reasoning_content === "string"
      ? msg.reasoning_content.slice(0, 4000)
      : "";
    // Defensive fallback: if the model still returned only reasoning (thinking
    // not fully honoured), expose it as content so callers get a usable answer.
    if (!content.trim() && reasoning.trim()) {
      content = reasoning;
    }
    return json({ content, reasoning }, 200);
  } catch (e) {
    return json({ error: e?.message || String(e) }, 500);
  }
});
