import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { ChatOpenAI } from "@langchain/openai";

dotenv.config();

// ======================================================
// BASIC SETUP
// ======================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 5000;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// The old MiniMax :free slug can become unavailable. Keep the model configurable.
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";

// ======================================================
// SERPER CONFIGURATION
// ======================================================

// Three independent keys are supported. The backend automatically rotates
// to the next key when the current key is exhausted/rejected.
const SERPER_API_KEYS = [
    process.env.SERPER_API_KEY_1,
    process.env.SERPER_API_KEY_2,
    process.env.SERPER_API_KEY_3
].filter(Boolean);

let activeSerperKeyIndex = 0;

const SERPER_ENDPOINT = "https://google.serper.dev/search";

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(cors());
app.use(express.json({ limit: "20mb" }));

// ======================================================
// FILE UPLOAD
// ======================================================

const uploadDirectory = path.join(__dirname, "tmp_uploads");

if (!fs.existsSync(uploadDirectory)) {
    fs.mkdirSync(uploadDirectory, { recursive: true });
}

const upload = multer({
    dest: uploadDirectory,
    limits: {
        fileSize: 12 * 1024 * 1024
    }
});

// ======================================================
// API KEY CHECK
// ======================================================

if (!OPENROUTER_API_KEY) {
    console.error("❌ OPENROUTER_API_KEY is missing in Backend/.env");
}

if (SERPER_API_KEYS.length === 0) {
    console.warn(
        "⚠️ No Serper API keys configured. Web fallback will be unavailable."
    );
}

// ======================================================
// CREATE OPENROUTER MODEL
// ======================================================

const aiModel = new ChatOpenAI({
    model: MODEL,
    apiKey: OPENROUTER_API_KEY,
    temperature: 0.7,
    maxTokens: 2000,
    configuration: {
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
            "HTTP-Referer": `http://localhost:${PORT}`,
            "X-Title": "AI LLM Chatbot"
        }
    }
});

// ======================================================
// SYSTEM PROMPT
// ======================================================

const normalSystemMessage = {
    role: "system",
    content: `
You are an intelligent and friendly AI assistant.

Answer the user's question directly and accurately.

For beginner questions, explain concepts in simple language.

For programming questions:
- provide working code
- explain the code
- mention where the code should be placed when useful

For academic questions:
- provide clear explanations
- use examples when useful
- structure answers neatly

When the user uploads an image:
- inspect the image carefully
- understand its visible text, diagrams, questions and objects
- answer questions based on the image

When the user uploads a file:
- use the extracted file content as context
- answer questions using that content

Important web-fallback rule:
- If the user asks for live, current, latest, today's, yesterday's, breaking, real-time,
  current weather, current scores, current prices, current news, or other information
  that you cannot reliably know from your available context, respond with exactly:
  NEED_WEB_SEARCH
- Do not add any explanation before or after NEED_WEB_SEARCH.

Do not claim to see or access something that was not provided.
Do not invent facts.
Be helpful, concise and clear.
`
};

// ======================================================
// HELPERS
// ======================================================

function normalizeReply(content) {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === "string") return part;
                if (part && typeof part.text === "string") return part.text;
                return "";
            })
            .join("");
    }

    if (content && typeof content.text === "string") {
        return content.text;
    }

    return "";
}

function sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return [];

    return messages
        .filter(message => {
            if (
                !message ||
                !["user", "assistant", "system"].includes(message.role)
            ) {
                return false;
            }

            if (typeof message.content === "string") {
                return message.content.trim().length > 0;
            }

            if (Array.isArray(message.content)) {
                return message.content.length > 0;
            }

            return false;
        })
        .slice(-20);
}

function containsImage(messages) {
    return messages.some(message => {
        if (!Array.isArray(message?.content)) return false;

        return message.content.some(
            part => part?.type === "image_url"
        );
    });
}

function isRateLimitError(error) {
    const status =
        error?.status ||
        error?.statusCode ||
        error?.response?.status;

    const message = String(error?.message || error || "").toLowerCase();

    return (
        Number(status) === 429 ||
        message.includes("429") ||
        message.includes("rate limit") ||
        message.includes("rate_limit") ||
        message.includes("model_rate_limit") ||
        message.includes("too many requests")
    );
}

function isUsableReply(reply) {
    const text = String(reply || "").trim();

    if (!text) return false;

    // The model may explicitly indicate that web/current information is needed.
    if (text === "NEED_WEB_SEARCH") return false;

    const lowered = text.toLowerCase();

    // Treat common model limitations/refusals as an OpenRouter failure for
    // the purpose of this app. This is what triggers the Serper fallback.
    const failurePhrases = [
        "i don't know",
        "i do not know",
        "i cannot answer",
        "i can't answer",
        "i cannot provide an accurate answer",
        "i can't provide an accurate answer",

        // Internet / browsing limitations
        "i don't have internet access",
        "i do not have internet access",
        "i don't have access to the internet",
        "i do not have access to the internet",
        "i cannot access the internet",
        "i can't access the internet",
        "i cannot browse the internet",
        "i can't browse the internet",
        "i cannot browse the web",
        "i can't browse the web",
        "i do not have web access",
        "i don't have web access",

        // Live/current information limitations
        "i don't have real-time",
        "i do not have real-time",
        "i can't provide real-time",
        "i cannot provide real-time",
        "i don't have realtime",
        "i do not have realtime",
        "i can't provide realtime",
        "i cannot provide realtime",
        "i don't have live data",
        "i do not have live data",
        "i can't access live data",
        "i cannot access live data",
        "i don't have current data",
        "i do not have current data",
        "i can't access current data",
        "i cannot access current data",
        "i don't have the latest information",
        "i do not have the latest information",
        "i can't provide the latest information",
        "i cannot provide the latest information",
        "i cannot verify the current",
        "i can't verify the current",
        "i'm unable to verify the current",
        "i am unable to verify the current",
        "i'm unable to verify real-time",
        "i am unable to verify real-time",

        // Typical suggestions to the user that indicate the model lacks data
        "check google",
        "search google",
        "check a weather website",
        "check an up-to-date source",
        "use a live source",
        "consult a live source"
    ];

    return !failurePhrases.some(phrase => lowered.includes(phrase));
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getSearchText(messages) {
    const userMessages = messages.filter(message => message.role === "user");

    const lastUser = userMessages[userMessages.length - 1];
    if (!lastUser) return "";

    if (typeof lastUser.content === "string") {
        return lastUser.content.trim();
    }

    if (Array.isArray(lastUser.content)) {
        return lastUser.content
            .filter(part => part?.type === "text")
            .map(part => part.text || "")
            .join(" ")
            .trim();
    }

    return "";
}

function compactSearchResults(data) {
    const organic = Array.isArray(data?.organic) ? data.organic : [];

    return organic.slice(0, 8).map((item, index) => ({
        rank: index + 1,
        title: item?.title || "",
        link: item?.link || "",
        snippet: item?.snippet || "",
        date: item?.date || ""
    }));
}

function isSerperKeyError(status) {
    // 401/403 -> invalid/unauthorized key
    // 402 -> credits/balance problem
    // 429 -> rate/usage limit
    return [401, 402, 403, 429].includes(Number(status));
}

// ======================================================
// OPENROUTER FIRST
// ======================================================

async function callOpenRouter(messages) {
    console.log(`🤖 Trying OpenRouter first using ${MODEL}`);

    const response = await aiModel.invoke([
        normalSystemMessage,
        ...messages
    ]);

    const reply = normalizeReply(response?.content).trim();

    if (!reply) {
        throw new Error("OpenRouter returned an empty response.");
    }

    return reply;
}

// ======================================================
// SERPER GOOGLE SEARCH WITH TWO-KEY FAILOVER
// ======================================================

async function searchWithSerper(query) {
    if (!SERPER_API_KEYS.length) {
        throw new Error("No Serper API keys are configured.");
    }

    const startingIndex = activeSerperKeyIndex;
    let lastError = null;

    for (let attempt = 0; attempt < SERPER_API_KEYS.length; attempt++) {
        const keyIndex = (startingIndex + attempt) % SERPER_API_KEYS.length;
        const apiKey = SERPER_API_KEYS[keyIndex];

        try {
            console.log(
                `🌐 Serper search using key ${keyIndex + 1}/${SERPER_API_KEYS.length}`
            );

            const response = await fetch(SERPER_ENDPOINT, {
                method: "POST",
                headers: {
                    "X-API-KEY": apiKey,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    q: query,
                    gl: "in",
                    hl: "en",
                    num: 8
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                const error = new Error(
                    `Serper returned ${response.status}: ${errorText}`
                );
                error.status = response.status;
                throw error;
            }

            const data = await response.json();

            // Remember the successful key so the next request prefers it.
            activeSerperKeyIndex = keyIndex;

            return data;
        } catch (error) {
            lastError = error;

            console.error(
                `❌ Serper key ${keyIndex + 1} failed:`,
                error?.message || error
            );

            if (!isSerperKeyError(error?.status)) {
                throw error;
            }

            if (SERPER_API_KEYS.length > 1) {
                activeSerperKeyIndex =
                    (keyIndex + 1) % SERPER_API_KEYS.length;

                console.log(
                    `🔁 Switching to Serper key ${activeSerperKeyIndex + 1}`
                );
            }
        }
    }

    throw lastError || new Error("All Serper API keys failed.");
}

// ======================================================
// BUILD ANSWER DIRECTLY FROM SERPER RESULTS
// ======================================================

function buildSerperFallbackAnswer(data) {
    const answerBox = data?.answerBox || {};
    const knowledgeGraph = data?.knowledgeGraph || {};
    const organic = Array.isArray(data?.organic) ? data.organic : [];

    // Serper can return a direct answer. Prefer it when available.
    if (answerBox.answer) {
        return answerBox.answer.trim();
    }

    if (answerBox.snippet) {
        return answerBox.snippet.trim();
    }

    // Knowledge Graph descriptions are also useful direct answers.
    if (knowledgeGraph.description) {
        let answer = knowledgeGraph.description.trim();
        if (knowledgeGraph.title) {
            answer = `${knowledgeGraph.title}: ${answer}`;
        }
        return answer;
    }

    // Last fallback: combine the most relevant Google result snippets.
    const usable = organic
        .filter(item => item?.title || item?.snippet)
        .slice(0, 5);

    if (!usable.length) {
        return "I could not find a useful answer from Google search results.";
    }

    const lines = usable.map((item, index) => {
        const title = item.title || `Result ${index + 1}`;
        const snippet = item.snippet || "";
        const link = item.link || "";
        return `${index + 1}. ${title}${snippet ? `\n${snippet}` : ""}${link ? `\n${link}` : ""}`;
    });

    return `I couldn't get an answer from the AI model, so I searched Google. Here are the most relevant results:\n\n${lines.join("\n\n")}`;
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/health", (req, res) => {
    res.json({
        success: true,
        status: "running",
        provider: "OpenRouter",
        framework: "LangChain.js",
        model: MODEL,
        imageSupport: true,
        webFallback: SERPER_API_KEYS.length > 0,
        serperKeysConfigured: SERPER_API_KEYS.length
    });
});

// ======================================================
// GET CHAT
// ======================================================

app.get("/api/chat", (req, res) => {
    res.json({
        success: false,
        message: "Use POST /api/chat."
    });
});

// ======================================================
// POST CHAT
// ======================================================

app.post("/api/chat", async (req, res) => {
    try {
        // -----------------------------------------------
        // CHECK OPENROUTER KEY
        // -----------------------------------------------

        if (!OPENROUTER_API_KEY) {
            return res.status(500).json({
                success: false,
                error: "OPENROUTER_API_KEY is missing in Backend/.env"
            });
        }

        // -----------------------------------------------
        // GET / VALIDATE MESSAGES
        // -----------------------------------------------

        const safeMessages = sanitizeMessages(req.body?.messages);

        if (!safeMessages.length) {
            return res.status(400).json({
                success: false,
                error: "No valid messages were provided."
            });
        }

        const imageRequest = containsImage(safeMessages);
        const searchQuery = getSearchText(safeMessages);

        console.log(
            imageRequest
                ? "🖼️ Image request detected"
                : "💬 Text request detected"
        );

        // =================================================
        // STEP 1: TRY OPENROUTER FIRST
        // =================================================

        try {
            const reply = await callOpenRouter(safeMessages);

            // HTTP/API success is not enough. If the model says it cannot
            // answer because it lacks live/current information, treat that
            // as an OpenRouter failure and continue to Serper.
            if (isUsableReply(reply)) {
                console.log("✅ OpenRouter provided a usable answer — Serper was not used");

                return res.json({
                    success: true,
                    reply,
                    modelUsed: MODEL,
                    provider: "OpenRouter",
                    framework: "LangChain.js",
                    multimodal: imageRequest,
                    webUsed: false
                });
            }

            console.log(
                "⚠️ OpenRouter responded, but the response is not usable for this question — switching to Serper"
            );
        } catch (openRouterError) {
            // Any technical OpenRouter failure immediately activates Serper.
            console.error(
                "❌ OpenRouter failed — switching to Serper:",
                openRouterError?.message || openRouterError
            );
        }

        // =================================================
        // STEP 2: SERPER FALLBACK ONLY AFTER OPENROUTER FAILS
        // =================================================

        if (!SERPER_API_KEYS.length) {
            return res.status(503).json({
                success: false,
                error: "OpenRouter failed and no Serper API keys are configured.",
                webUsed: false
            });
        }

        if (!searchQuery) {
            return res.status(503).json({
                success: false,
                error: "OpenRouter failed, but there is no text query available for Google fallback.",
                webUsed: false
            });
        }

        let searchData;

        try {
            searchData = await searchWithSerper(searchQuery);
        } catch (serperError) {
            console.error(
                "❌ All Serper keys failed:",
                serperError?.message || serperError
            );

            return res.status(502).json({
                success: false,
                error: "OpenRouter failed and all 3 Serper API keys are unavailable.",
                details: serperError?.message || "Serper request failed",
                webUsed: true
            });
        }

        const searchResults = compactSearchResults(searchData);

        if (!searchResults.length && !searchData?.answerBox && !searchData?.knowledgeGraph) {
            return res.status(404).json({
                success: false,
                error: "OpenRouter failed and Google returned no useful search results.",
                webUsed: true
            });
        }

        // =================================================
        // STEP 3: RETURN THE SERPER ANSWER
        // =================================================

        const fallbackReply = buildSerperFallbackAnswer(searchData);

        return res.json({
            success: true,
            reply: fallbackReply,
            modelUsed: null,
            provider: "Serper Google Search",
            framework: "LangChain.js + Serper fallback",
            multimodal: imageRequest,
            webUsed: true,
            sources: searchResults.map(item => ({
                title: item.title,
                link: item.link
            }))
        });
    } catch (error) {
        console.error(
            "❌ Chat error:",
            error?.message || error
        );

        return res.status(500).json({
            success: false,
            error: error?.message || "Failed to process the request."
        });
    }
});

// ======================================================
// FILE EXTRACTION
// ======================================================

app.post(
    "/api/extract-file",
    upload.single("file"),
    async (req, res) => {
        let tempPath = req.file?.path;

        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    error: "No file was uploaded."
                });
            }

            const originalName = req.file.originalname;
            const extension = path.extname(originalName).toLowerCase();
            let text = "";

            // ------------------------------------------
            // PDF
            // ------------------------------------------

            if (extension === ".pdf") {
                const buffer = fs.readFileSync(tempPath);
                const parsed = await pdfParse(buffer);
                text = parsed.text || "";
            }

            // ------------------------------------------
            // DOCX
            // ------------------------------------------

            else if (extension === ".docx") {
                const result = await mammoth.extractRawText({
                    path: tempPath
                });
                text = result.value || "";
            }

            // ------------------------------------------
            // NORMAL TEXT FILE
            // ------------------------------------------

            else {
                text = fs.readFileSync(tempPath, "utf8");
            }

            if (!text.trim()) {
                return res.status(422).json({
                    success: false,
                    error: "No readable text was found in this file."
                });
            }

            return res.json({
                success: true,
                filename: originalName,
                text: text.slice(0, 60000)
            });
        } catch (error) {
            console.error(
                "❌ File extraction error:",
                error?.message || error
            );

            return res.status(500).json({
                success: false,
                error: "Could not extract text from this file."
            });
        } finally {
            if (tempPath) {
                try {
                    fs.unlinkSync(tempPath);
                } catch {}
            }
        }
    }
);

// ======================================================
// SERVE FRONTEND
// ======================================================

const frontendPath = path.join(__dirname, "../Frontend");

app.use(express.static(frontendPath));

app.get("/", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
});

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
    console.log("============================================");
    console.log("        🤖 AI CHATBOT");
    console.log("============================================");
    console.log(`Server       : http://localhost:${PORT}`);
    console.log(`Health       : http://localhost:${PORT}/health`);
    console.log("AI Provider  : OpenRouter");
    console.log("Framework    : LangChain.js");
    console.log(`Model        : ${MODEL}`);
    console.log(`Serper keys  : ${SERPER_API_KEYS.length}`);
    console.log("Web fallback : ✅ Backend automatic");
    console.log("Text         : ✅");
    console.log("Images       : ✅");
    console.log("Files        : ✅");
    console.log("Voice input  : ✅ Browser");
    console.log("Text speech  : ✅ Browser");
    console.log("============================================");
});
