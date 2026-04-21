/**
 * Cloudflare Worker - Gemini OCR Reverse Proxy (支持多Key与多模型轮询)
 *
 * Warning:
 * 1) Built-in API Key is convenient but insecure for production.
 * 2) Prefer using Cloudflare secret: wrangler secret put GEMINI_API_KEYS (多个用逗号分隔)
 */

// 改为数组，填入你的多个 Key
const GEMINI_API_KEYS = [
  "2",
  "1","3"
];

// 改为数组，填入你想要轮询的多个模型
const GEMINI_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemma-3-1b-it",
];

const DEFAULT_OCR_PROMPT = `你现在是ocr识别服务，直接输出你现在识别到的中文，数字，英文，不要说其他的`;

// 全局轮询计数器（在每个 Worker Isolate 实例中独立维护）
let currentKeyIndex = 0;
let currentModelIndex = 0;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
      ...extraHeaders,
    },
  });
}

function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!res.ok) throw new Error(`下载图片失败: ${res.status} ${res.statusText}`);
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const arr = new Uint8Array(await res.arrayBuffer());
  return { imageBase64: toBase64(arr), mimeType };
}

function extractGeminiText(result) {
  try {
    const parts = result?.candidates?.[0]?.content?.parts || [];
    return parts
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

async function callGeminiOCR({ apiKey, model, prompt, mimeType, imageBase64 }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }

  if (!res.ok) {
    throw new Error(`Gemini API错误: ${res.status} ${res.statusText} - ${raw}`);
  }

  return body;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,authorization",
        },
      });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        name: "cf-worker-gemini-ocr-proxy",
        endpoints: {
          health: "GET /health",
          ocr: "POST /ocr",
        },
        usage: {
          body_json: {
            image_base64: "必填（与 image_url 二选一）",
            image_url: "必填（与 image_base64 二选一）",
            mime_type: "可选，默认 image/jpeg",
            prompt: "可选，默认内置OCR提示词",
          },
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, ts: new Date().toISOString() });
    }

    if (request.method === "POST" && url.pathname === "/ocr") {
      let input;
      try {
        input = await request.json();
      } catch {
        return json({ error: "请求体必须是 JSON" }, 400);
      }

      const prompt = (input.prompt || DEFAULT_OCR_PROMPT).trim();
      let mimeType = (input.mime_type || "image/jpeg").trim();
      let imageBase64 = (input.image_base64 || "").trim();

      if (!imageBase64 && input.image_url) {
        try {
          const img = await fetchImageAsBase64(String(input.image_url));
          imageBase64 = img.imageBase64;
          if (!input.mime_type) mimeType = img.mimeType;
        } catch (err) {
          return json({ error: String(err.message || err) }, 400);
        }
      }

      if (!imageBase64) {
        return json({ error: "缺少 image_base64 或 image_url" }, 400);
      }

      // --- 解析并轮询 Keys ---
      let keys = GEMINI_API_KEYS;
      if (env.GEMINI_API_KEYS) {
        keys = env.GEMINI_API_KEYS.split(",").map(k => k.trim()).filter(Boolean);
      } else if (env.GEMINI_API_KEY) {
        keys = [env.GEMINI_API_KEY]; // 兼容旧版单Key环境变量
      }

      if (!keys || keys.length === 0 || keys[0].includes("REPLACE_WITH")) {
        return json({
          error: "未配置有效的 Gemini API Key",
          hint: "请在代码中替换 GEMINI_API_KEYS，或设置 wrangler secret: GEMINI_API_KEYS（多个用逗号分隔）",
        }, 500);
      }

      const apiKey = keys[currentKeyIndex % keys.length];
      currentKeyIndex = (currentKeyIndex + 1) % keys.length; // 递增并防止溢出

      // --- 解析并轮询 Models ---
      let models = GEMINI_MODELS;
      if (env.GEMINI_MODELS) {
        models = env.GEMINI_MODELS.split(",").map(m => m.trim()).filter(Boolean);
      } else if (env.GEMINI_MODEL) {
        models = [env.GEMINI_MODEL];
      }

      const selectedModel = models[currentModelIndex % models.length];
      currentModelIndex = (currentModelIndex + 1) % models.length;

      try {
        const geminiResp = await callGeminiOCR({
          apiKey,
          model: selectedModel,
          prompt,
          mimeType,
          imageBase64,
        });

        const text = extractGeminiText(geminiResp);

        return json({
          ok: true,
          model: selectedModel, // 返回本次轮询实际使用的模型
          prompt_used: prompt,
          text,
          raw: geminiResp,
        });
      } catch (err) {
        return json({ error: String(err.message || err) }, 502);
      }
    }

    return json({ error: "Not Found" }, 404);
  },
};