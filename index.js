const express = require("express");
const axios = require("axios");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POST_DELAY_SECONDS = Number(process.env.POST_DELAY_SECONDS || 30);

const HELP_LINK = "https://t.me/swedyfinder";
const SPREADSHEET_LINK = "https://doppel.fit/@swedyfinds";

const EMOJI_DNA = "\u{1F9EC}";
const EMOJI_MONEY = "\u{1F4B6}";
const EMOJI_LINK = "\u{1F517}";
const EMOJI_HELP = "\u{2753}";
const EMOJI_CHEERS = "\u{1F942}";

const WANTED_AGENTS = [
  "Litbuy",
  "Hipobuy",
  "KakoBuy",
  "Lovegobuy",
  "CSSBuy",
  "MuleBuy",
];

const app = express();

app.get("/", (req, res) => {
  res.send("Discord to Telegram bot is running.");
});

app.get("/health", (req, res) => {
  res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeUrl(url) {
  const value = String(url || "").trim();
  if (!value.startsWith("http://") && !value.startsWith("https://")) return "";
  return value.replace(/"/g, "%22");
}

function isImageUrl(url) {
  const value = String(url || "");
  return (
    /\.(png|jpg|jpeg|webp|gif)(\?|$)/i.test(value) ||
    value.includes("cdn.doppel.fit") ||
    value.includes("images-ext-1.discordapp.net") ||
    value.includes("cdn.discordapp.com")
  );
}

// Added only for duplicate-image prevention.
// Everything else stays like the old working code.
function normalizeImageKey(url) {
  let value = String(url || "");

  try {
    value = decodeURIComponent(value);
  } catch {}

  return value
    .replace(
      /^https?:\/\/images-ext-\d+\.discordapp\.net\/external\/[^/]+\//,
      ""
    )
    .replace(/^https?:\/\/media\.discordapp\.net\//, "")
    .replace(/^https?:\/\/cdn\.discordapp\.com\//, "")
    .replace(/^https?:\/\/cdn\.doppel\.fit\//, "")
    .split("?")[0]
    .split("#")[0];
}

function dedupeImageUrls(urls) {
  const seen = new Set();
  const result = [];

  for (const url of urls) {
    if (!url) continue;

    const key = normalizeImageKey(url);

    if (seen.has(key)) {
      console.log("Removed duplicate image:", url);
      continue;
    }

    seen.add(key);
    result.push(url);
  }

  return result;
}

function normalizeAgentName(label) {
  const lower = String(label || "").toLowerCase();

  for (const agent of WANTED_AGENTS) {
    if (lower.includes(agent.toLowerCase())) return agent;
  }

  return "";
}

function walk(value, visitor, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, path.concat(index)));
    return;
  }

  if (value && typeof value === "object") {
    visitor(value, path);

    for (const [key, val] of Object.entries(value)) {
      walk(val, visitor, path.concat(key));
    }
  }
}

function collectFromMessage(message) {
  const raw = message.toJSON ? message.toJSON() : message;

  const textParts = [];
  const imageUrls = [];
  const buttonLinks = new Map();

  if (message.content) textParts.push(message.content);

  for (const attachment of message.attachments?.values?.() || []) {
    if (attachment.url && isImageUrl(attachment.url)) {
      imageUrls.push(attachment.url);
    }
  }

  for (const embed of message.embeds || []) {
    if (embed.title) textParts.push(embed.title);
    if (embed.description) textParts.push(embed.description);

    if (Array.isArray(embed.fields)) {
      for (const field of embed.fields) {
        textParts.push(`${field.name || ""} ${field.value || ""}`);
      }
    }

    if (embed.image?.url) imageUrls.push(embed.image.url);
    if (embed.thumbnail?.url) imageUrls.push(embed.thumbnail.url);
    if (embed.url) textParts.push(embed.url);
  }

  walk(raw, (obj) => {
    for (const key of ["content", "text", "title", "description"]) {
      if (typeof obj[key] === "string" && obj[key].trim()) {
        textParts.push(obj[key]);
      }
    }

    for (const key of ["url", "proxy_url", "src"]) {
      if (typeof obj[key] === "string" && isImageUrl(obj[key])) {
        imageUrls.push(obj[key]);
      }
    }

    if (obj.media && typeof obj.media === "object") {
      if (typeof obj.media.url === "string" && isImageUrl(obj.media.url)) {
        imageUrls.push(obj.media.url);
      }

      if (
        typeof obj.media.proxy_url === "string" &&
        isImageUrl(obj.media.proxy_url)
      ) {
        imageUrls.push(obj.media.proxy_url);
      }
    }

    const label = obj.label || obj?.data?.label;
    const url = obj.url || obj?.data?.url;

    if (label && url) {
      const agent = normalizeAgentName(label);

      if (agent && !buttonLinks.has(agent)) {
        buttonLinks.set(agent, url);
      }
    }
  });

  const uniqueImages = dedupeImageUrls(imageUrls);

  console.log(
    `Found ${imageUrls.length} raw image URLs, ${uniqueImages.length} unique image URLs`
  );

  return {
    text: [...new Set(textParts.filter(Boolean))].join("\n"),
    imageUrls: uniqueImages.slice(0, 10),
    buttonLinks,
  };
}

function extractProductName(text) {
  const input = String(text || "");

  const markdownMatch = input.match(/\[([^\]]{3,200})\]\((https?:\/\/[^)]+)\)/);

  if (markdownMatch) {
    return markdownMatch[1].trim();
  }

  const lines = input
    .split(/\n+/)
    .map((line) => line.replace(/[*_`]/g, "").trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/[$€]\s?\d/.test(line)) continue;
    if (/\d+\s*QCs?/i.test(line)) continue;
    if (/\d+\s*(g|kg)\b/i.test(line)) continue;
    if (/\d+(?:[.,]\d+)?\s*[×xX]\s*\d+/i.test(line)) continue;
    if (line.startsWith("http")) continue;

    return line.slice(0, 120);
  }

  return "Product";
}

function extractPrice(text) {
  const input = String(text || "");

  const patterns = [
    /[$€]\s?\d+(?:[.,]\d{1,2})?/,
    /\d+(?:[.,]\d{1,2})?\s?[$€]/,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);

    if (match) {
      return match[0].replace(/\s/g, "");
    }
  }

  return "";
}

function buildAgentLines(buttonLinks) {
  const lines = [];

  for (const agent of WANTED_AGENTS) {
    const url = buttonLinks.get(agent);

    if (!url) continue;

    lines.push(
      `<a href="${safeUrl(url)}">${EMOJI_LINK} ${escapeHtml(agent)}</a>`
    );
  }

  return lines.join("\n");
}

function buildCaption({ productName, price, agentLines }) {
  const lines = [];

  lines.push(`${EMOJI_DNA} <b>${escapeHtml(productName)}</b> ${EMOJI_DNA}`);

  if (price) {
    lines.push(`${EMOJI_MONEY} Price: ${escapeHtml(price)}`);
  }

  lines.push("");

  if (agentLines) {
    lines.push(agentLines);
  }

  lines.push("");
  lines.push(
    `<a href="${HELP_LINK}">${EMOJI_HELP} ASK HERE FOR HELP &amp; FINDS</a>`
  );
  lines.push(
    `<a href="${SPREADSHEET_LINK}">${EMOJI_CHEERS} SWEDY SPREADSHEET ${EMOJI_CHEERS}</a>`
  );

  return lines.join("\n").trim();
}

function splitTelegramText(text, maxLength = 4096) {
  const chunks = [];
  let rest = text;

  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf("\n", maxLength);

    if (cut < 1000) cut = maxLength;

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }

  if (rest) chunks.push(rest);

  return chunks;
}

const telegram = axios.create({
  baseURL: `https://api.telegram.org/bot${TELEGRAM_TOKEN}`,
  timeout: 30000,
});

async function telegramPost(method, payload) {
  try {
    const response = await telegram.post(`/${method}`, payload);
    return response.data;
  } catch (error) {
    const data = error.response?.data;

    if (error.response?.status === 429 && data?.parameters?.retry_after) {
      const wait = Number(data.parameters.retry_after) + 1;

      console.log(`Telegram rate limit. Waiting ${wait}s`);
      await sleep(wait * 1000);

      const retry = await telegram.post(`/${method}`, payload);
      return retry.data;
    }

    throw error;
  }
}

async function sendText(text) {
  const chunks = splitTelegramText(text);

  for (const chunk of chunks) {
    await telegramPost("sendMessage", {
      chat_id: TELEGRAM_CHAT_ID,
      text: chunk,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });

    console.log("Sent Telegram text");
    await sleep(1000);
  }
}

async function sendProduct({ imageUrls, caption }) {
  if (imageUrls.length > 1) {
    const mediaCaption =
      caption.length <= 1024 ? caption : caption.slice(0, 950) + "\n\n...";

    const media = imageUrls.map((url, index) => {
      const item = {
        type: "photo",
        media: url,
      };

      if (index === 0) {
        item.caption = mediaCaption;
        item.parse_mode = "HTML";
      }

      return item;
    });

    try {
      console.log(`Trying to send MediaGroup with ${imageUrls.length} images`);

      await telegramPost("sendMediaGroup", {
        chat_id: TELEGRAM_CHAT_ID,
        media,
      });

      console.log("Sent MediaGroup with caption");

      if (caption.length > 1024) {
        await sleep(1000);
        await sendText(caption);
      }

      return;
    } catch (error) {
      console.error("MediaGroup failed. Falling back to first image.");
      console.error("MediaGroup error:", error.response?.data || error.message);
    }
  }

  if (imageUrls.length >= 1) {
    const photoCaption =
      caption.length <= 1024 ? caption : caption.slice(0, 950) + "\n\n...";

    await telegramPost("sendPhoto", {
      chat_id: TELEGRAM_CHAT_ID,
      photo: imageUrls[0],
      caption: photoCaption,
      parse_mode: "HTML",
    });

    console.log("Sent one photo with caption");

    if (caption.length > 1024) {
      await sleep(1000);
      await sendText(caption);
    }

    return;
  }

  await sendText(caption);
}

const queue = [];
let isProcessing = false;
const processedIds = new Set();

async function processQueue() {
  if (isProcessing) return;

  isProcessing = true;

  try {
    while (queue.length > 0) {
      const message = queue.shift();

      try {
        console.log(`Processing Discord message ${message.id}`);

        const collected = collectFromMessage(message);
        const productName = extractProductName(collected.text);
        const price = extractPrice(collected.text);
        const agentLines = buildAgentLines(collected.buttonLinks);

        const caption = buildCaption({
          productName,
          price,
          agentLines,
        });

        console.log("Product:", productName);
        console.log("Price:", price || "none");
        console.log("Images:", collected.imageUrls.length);
        console.log(
          "Agents:",
          [...collected.buttonLinks.keys()].join(", ") || "none"
        );

        await sendProduct({
          imageUrls: collected.imageUrls,
          caption,
        });

        console.log(`Finished Discord message ${message.id}`);
      } catch (error) {
        console.error(
          `Error processing ${message.id}:`,
          error.response?.data || error.message
        );
      }

      console.log(`Waiting ${POST_DELAY_SECONDS}s before next post`);
      await sleep(POST_DELAY_SECONDS * 1000);
    }
  } finally {
    isProcessing = false;

    if (queue.length > 0) {
      processQueue();
    }
  }
}

if (
  !DISCORD_TOKEN ||
  !TELEGRAM_TOKEN ||
  !DISCORD_CHANNEL_ID ||
  !TELEGRAM_CHAT_ID
) {
  console.error(
    "Missing env vars. Required: DISCORD_TOKEN, TELEGRAM_TOKEN, DISCORD_CHANNEL_ID, TELEGRAM_CHAT_ID"
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once("ready", () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
  console.log(`Watching Discord channel ${DISCORD_CHANNEL_ID}`);
});

client.on("messageCreate", (message) => {
  if (!message) return;
  if (message.author?.id === client.user?.id) return;
  if (message.channelId !== DISCORD_CHANNEL_ID) return;

  if (processedIds.has(message.id)) {
    console.log(`Skipped duplicate ${message.id}`);
    return;
  }

  processedIds.add(message.id);

  if (processedIds.size > 500) {
    const first = processedIds.values().next().value;
    processedIds.delete(first);
  }

  queue.push(message);

  console.log(`Added to queue ${message.id}. Queue size: ${queue.length}`);

  processQueue();
});

client.on("error", (error) =>
  console.error("Discord client error:", error.message)
);
client.on("shardDisconnect", () => console.log("Discord disconnected"));
client.on("shardReconnecting", () => console.log("Discord reconnecting"));
client.on("shardResume", () => console.log("Discord reconnected"));

client.login(DISCORD_TOKEN);
