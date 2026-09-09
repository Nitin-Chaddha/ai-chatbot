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

// Model can be changed from .env.
// Default is OpenRouter's free router.
const MODEL =
    process.env.OPENROUTER_MODEL || "openrouter/free";

// ======================================================
// SERPER CONFIGURATION - 3 API KEYS
// ======================================================

const SERPER_API_KEYS = [
    process.env.SERPER_API_KEY_1,
    process.env.SERPER_API_KEY_2,
    process.env.SERPER_API_KEY_3
].filter(Boolean);

let activeSerperKeyIndex = 0;

const SERPER_ENDPOINT =
    "https://google.serper.dev/search";

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(cors());

app.use(
    express.json({
        limit: "20mb"
    })
);

// ======================================================
// FILE UPLOAD
// ======================================================

const uploadDirectory = path.join(
    __dirname,
    "tmp_uploads"
);

if (!fs.existsSync(uploadDirectory)) {
    fs.mkdirSync(uploadDirectory, {
        recursive: true
    });
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
    console.error(
        "❌ OPENROUTER_API_KEY is missing in Backend/.env"
    );
}

if (SERPER_API_KEYS.length === 0) {
    console.warn(
        "⚠️ No Serper API keys configured. Web fallback will be unavailable."
    );
} else {
    console.log(
        `✅ ${SERPER_API_KEYS.length} Serper API key(s) configured.`
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
        baseURL:
            "https://openrouter.ai/api/v1",

        defaultHeaders: {
            "HTTP-Referer":
                `http://localhost:${PORT}`,

            "X-Title":
                "AI LLM Chatbot"
        }
    }
});

// ======================================================
// SYSTEM MESSAGE
// ======================================================

const normalSystemMessage = {
    role: "system",

    content: `
You are an intelligent and friendly AI assistant.

Answer the user's question directly and accurately.

For beginner questions:
- Explain concepts in simple language.
- Give examples when useful.

For programming questions:
- Provide working code.
- Explain the code.
- Mention where the code should be placed when useful.

For academic questions:
- Provide clear explanations.
- Use examples.
- Structure the answer neatly.

When the user uploads an image:
- Inspect the image carefully.
- Understand visible text, diagrams, questions and objects.
- Answer questions based on the image.

When the user uploads a file:
- Use the extracted file content as context.
- Answer questions using that content.

Important:
- Do not invent facts.
- Do not claim to see something that was not provided.
- Be helpful, concise and clear.
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
            .map((part) => {
                if (typeof part === "string") {
                    return part;
                }

                if (
                    part &&
                    typeof part.text === "string"
                ) {
                    return part.text;
                }

                return "";
            })
            .join("");
    }

    if (
        content &&
        typeof content.text === "string"
    ) {
        return content.text;
    }

    return "";
}

// ======================================================
// SANITIZE CHAT MESSAGES
// ======================================================

function sanitizeMessages(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }

    return messages
        .filter((message) => {
            if (
                !message ||
                ![
                    "user",
                    "assistant",
                    "system"
                ].includes(message.role)
            ) {
                return false;
            }

            if (
                typeof message.content ===
                "string"
            ) {
                return (
                    message.content.trim()
                        .length > 0
                );
            }

            if (
                Array.isArray(
                    message.content
                )
            ) {
                return (
                    message.content.length > 0
                );
            }

            return false;
        })
        .slice(-20);
}

// ======================================================
// CHECK IMAGE
// ======================================================

function containsImage(messages) {
    return messages.some((message) => {
        if (
            !Array.isArray(
                message?.content
            )
        ) {
            return false;
        }

        return message.content.some(
            (part) =>
                part?.type ===
                "image_url"
        );
    });
}

// ======================================================
// GET TEXT QUERY
// ======================================================

function getSearchText(messages) {
    const userMessages =
        messages.filter(
            (message) =>
                message.role === "user"
        );

    const lastUser =
        userMessages[
            userMessages.length - 1
        ];

    if (!lastUser) {
        return "";
    }

    if (
        typeof lastUser.content ===
        "string"
    ) {
        return lastUser.content.trim();
    }

    if (
        Array.isArray(
            lastUser.content
        )
    ) {
        return lastUser.content
            .filter(
                (part) =>
                    part?.type === "text"
            )
            .map(
                (part) =>
                    part.text || ""
            )
            .join(" ")
            .trim();
    }

    return "";
}

// ======================================================
// SERPER ERROR CHECK
// ======================================================

function isSerperKeyError(status) {
    const code = Number(status);

    return [
        401, // Invalid API key
        402, // Credits/billing problem
        403, // Forbidden
        429  // Rate/usage limit
    ].includes(code);
}

// ======================================================
// OPENROUTER FIRST
// ======================================================

async function callOpenRouter(messages) {
    console.log(
        `🤖 Trying OpenRouter first using model: ${MODEL}`
    );

    const response =
        await aiModel.invoke([
            normalSystemMessage,
            ...messages
        ]);

    const reply =
        normalizeReply(
            response?.content
        ).trim();

    if (!reply) {
        throw new Error(
            "OpenRouter returned an empty response."
        );
    }

    return reply;
}

// ======================================================
// SERPER SEARCH
// ======================================================
//
// IMPORTANT:
// Serper is called ONLY if OpenRouter fails.
//
// Key 1 → Key 2 → Key 3
//
// If a key returns 401 / 402 / 403 / 429,
// the backend automatically tries the next key.
// ======================================================

async function searchWithSerper(query) {
    if (
        SERPER_API_KEYS.length === 0
    ) {
        throw new Error(
            "No Serper API keys are configured."
        );
    }

    const startingIndex =
        activeSerperKeyIndex;

    let lastError = null;

    for (
        let attempt = 0;
        attempt <
        SERPER_API_KEYS.length;
        attempt++
    ) {
        const keyIndex =
            (
                startingIndex +
                attempt
            ) %
            SERPER_API_KEYS.length;

        const apiKey =
            SERPER_API_KEYS[
                keyIndex
            ];

        try {
            console.log(
                `🌐 Serper search using key ${keyIndex + 1}/${SERPER_API_KEYS.length}`
            );

            const response =
                await fetch(
                    SERPER_ENDPOINT,
                    {
                        method: "POST",

                        headers: {
                            "X-API-KEY":
                                apiKey,

                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify(
                            {
                                q: query,

                                gl: "in",

                                hl: "en",

                                num: 8
                            }
                        )
                    }
                );

            if (!response.ok) {
                const errorText =
                    await response.text();

                const error =
                    new Error(
                        `Serper returned ${response.status}: ${errorText}`
                    );

                error.status =
                    response.status;

                throw error;
            }

            const data =
                await response.json();

            // Remember the key that worked.
            activeSerperKeyIndex =
                keyIndex;

            console.log(
                `✅ Serper key ${keyIndex + 1} worked successfully.`
            );

            return data;

        } catch (error) {
            lastError = error;

            console.error(
                `❌ Serper key ${keyIndex + 1} failed:`,
                error?.message ||
                    error
            );

            // Only rotate for key/credit/rate-limit
            // related failures.
            if (
                !isSerperKeyError(
                    error?.status
                )
            ) {
                throw error;
            }

            // Move to next key.
            activeSerperKeyIndex =
                (
                    keyIndex + 1
                ) %
                SERPER_API_KEYS.length;

            console.log(
                `🔁 Switching to Serper key ${activeSerperKeyIndex + 1}`
            );
        }
    }

    throw (
        lastError ||
        new Error(
            "All Serper API keys failed."
        )
    );
}

// ======================================================
// COMPACT SEARCH RESULTS
// ======================================================

function compactSearchResults(data) {
    const organic =
        Array.isArray(data?.organic)
            ? data.organic
            : [];

    return organic
        .slice(0, 8)
        .map(
            (item, index) => ({
                rank: index + 1,

                title:
                    item?.title || "",

                link:
                    item?.link || "",

                snippet:
                    item?.snippet || "",

                date:
                    item?.date || ""
            })
        );
}

// ======================================================
// BUILD ANSWER FROM SERPER
// ======================================================

function buildSerperFallbackAnswer(
    data
) {
    const answerBox =
        data?.answerBox || {};

    const knowledgeGraph =
        data?.knowledgeGraph || {};

    const organic =
        Array.isArray(data?.organic)
            ? data.organic
            : [];

    // ------------------------------------------
    // GOOGLE ANSWER BOX
    // ------------------------------------------

    if (
        answerBox.answer
    ) {
        return answerBox.answer
            .trim();
    }

    if (
        answerBox.snippet
    ) {
        return answerBox.snippet
            .trim();
    }

    // ------------------------------------------
    // KNOWLEDGE GRAPH
    // ------------------------------------------

    if (
        knowledgeGraph.description
    ) {
        let answer =
            knowledgeGraph
                .description
                .trim();

        if (
            knowledgeGraph.title
        ) {
            answer =
                `${knowledgeGraph.title}: ${answer}`;
        }

        return answer;
    }

    // ------------------------------------------
    // GOOGLE SEARCH RESULTS
    // ------------------------------------------

    const usable =
        organic
            .filter(
                (item) =>
                    item?.title ||
                    item?.snippet
            )
            .slice(0, 5);

    if (!usable.length) {
        return (
            "I could not find a useful answer from Google search results."
        );
    }

    const lines =
        usable.map(
            (item, index) => {
                const title =
                    item.title ||
                    `Result ${index + 1}`;

                const snippet =
                    item.snippet ||
                    "";

                const link =
                    item.link || "";

                return (
                    `${index + 1}. ${title}` +
                    (
                        snippet
                            ? `\n${snippet}`
                            : ""
                    ) +
                    (
                        link
                            ? `\n${link}`
                            : ""
                    )
                );
            }
        );

    return (
        "I couldn't get an answer from the AI model, " +
        "so I searched Google. Here are the most relevant results:\n\n" +
        lines.join("\n\n")
    );
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
    "/health",
    (req, res) => {
        res.json({
            success: true,

            status: "running",

            provider:
                "OpenRouter",

            framework:
                "LangChain.js",

            model: MODEL,

            imageSupport:
                true,

            webFallback:
                SERPER_API_KEYS.length >
                0,

            serperKeysConfigured:
                SERPER_API_KEYS.length
        });
    }
);

// ======================================================
// GET CHAT
// ======================================================

app.get(
    "/api/chat",
    (req, res) => {
        res.json({
            success: false,

            message:
                "Use POST /api/chat."
        });
    }
);

// ======================================================
// POST CHAT
// ======================================================

app.post(
    "/api/chat",
    async (req, res) => {
        try {
            // ==========================================
            // OPENROUTER API KEY CHECK
            // ==========================================

            if (!OPENROUTER_API_KEY) {
                return res
                    .status(500)
                    .json({
                        success:
                            false,

                        error:
                            "OPENROUTER_API_KEY is missing in Backend/.env"
                    });
            }

            // ==========================================
            // SANITIZE MESSAGES
            // ==========================================

            const safeMessages =
                sanitizeMessages(
                    req.body?.messages
                );

            if (
                !safeMessages.length
            ) {
                return res
                    .status(400)
                    .json({
                        success:
                            false,

                        error:
                            "No valid messages were provided."
                    });
            }

            const imageRequest =
                containsImage(
                    safeMessages
                );

            const searchQuery =
                getSearchText(
                    safeMessages
                );

            console.log(
                imageRequest
                    ? "🖼️ Image request detected"
                    : "💬 Text request detected"
            );

            // ==========================================
            // STEP 1
            // ALWAYS TRY OPENROUTER FIRST
            // ==========================================

            try {
                const reply =
                    await callOpenRouter(
                        safeMessages
                    );

                // IMPORTANT:
                // If OpenRouter succeeds,
                // STOP HERE.
                //
                // Serper is NOT called.
                // ======================================

                console.log(
                    "✅ OpenRouter answered successfully."
                );

                console.log(
                    "🚫 Serper was NOT used."
                );

                return res.json({
                    success:
                        true,

                    reply,

                    modelUsed:
                        MODEL,

                    provider:
                        "OpenRouter",

                    framework:
                        "LangChain.js",

                    multimodal:
                        imageRequest,

                    webUsed:
                        false
                });

            } catch (
                openRouterError
            ) {

                // ======================================
                // OPENROUTER FAILED
                // NOW AND ONLY NOW USE SERPER
                // ======================================

                console.error(
                    "❌ OpenRouter failed."
                );

                console.error(
                    "Reason:",
                    openRouterError
                        ?.message ||
                        openRouterError
                );

                console.log(
                    "🌐 Starting Serper fallback..."
                );
            }

            // ==========================================
            // STEP 2
            // SERPER FALLBACK
            // ==========================================

            if (
                SERPER_API_KEYS.length ===
                0
            ) {
                return res
                    .status(503)
                    .json({
                        success:
                            false,

                        error:
                            "OpenRouter failed and no Serper API keys are configured.",

                        webUsed:
                            false
                    });
            }

            if (
                !searchQuery
            ) {
                return res
                    .status(503)
                    .json({
                        success:
                            false,

                        error:
                            "OpenRouter failed, but there is no text query available for Google fallback.",

                        webUsed:
                            false
                    });
            }

            let searchData;

            try {
                searchData =
                    await searchWithSerper(
                        searchQuery
                    );

            } catch (
                serperError
            ) {

                console.error(
                    "❌ All configured Serper keys failed:",
                    serperError
                        ?.message ||
                        serperError
                );

                return res
                    .status(502)
                    .json({
                        success:
                            false,

                        error:
                            "OpenRouter failed and all 3 Serper API keys are unavailable.",

                        details:
                            serperError
                                ?.message ||
                            "Serper request failed",

                        webUsed:
                            true
                    });
            }

            // ==========================================
            // EXTRACT RESULTS
            // ==========================================

            const searchResults =
                compactSearchResults(
                    searchData
                );

            if (
                !searchResults.length &&
                !searchData?.answerBox &&
                !searchData?.knowledgeGraph
            ) {
                return res
                    .status(404)
                    .json({
                        success:
                            false,

                        error:
                            "OpenRouter failed and Google returned no useful search results.",

                        webUsed:
                            true
                    });
            }

            // ==========================================
            // STEP 3
            // RETURN SERPER ANSWER
            // ==========================================

            const fallbackReply =
                buildSerperFallbackAnswer(
                    searchData
                );

            console.log(
                "✅ Serper fallback completed successfully."
            );

            return res.json({
                success:
                    true,

                reply:
                    fallbackReply,

                modelUsed:
                    null,

                provider:
                    "Serper Google Search",

                framework:
                    "LangChain.js + Serper fallback",

                multimodal:
                    imageRequest,

                webUsed:
                    true,

                sources:
                    searchResults.map(
                        (item) => ({
                            title:
                                item.title,

                            link:
                                item.link
                        })
                    )
            });

        } catch (error) {

            console.error(
                "❌ Chat error:",
                error?.message ||
                    error
            );

            return res
                .status(500)
                .json({
                    success:
                        false,

                    error:
                        error?.message ||
                        "Failed to process the request."
                });
        }
    }
);

// ======================================================
// FILE EXTRACTION
// ======================================================

app.post(
    "/api/extract-file",
    upload.single("file"),

    async (req, res) => {
        let tempPath =
            req.file?.path;

        try {
            if (!req.file) {
                return res
                    .status(400)
                    .json({
                        success:
                            false,

                        error:
                            "No file was uploaded."
                    });
            }

            const originalName =
                req.file.originalname;

            const extension =
                path.extname(
                    originalName
                ).toLowerCase();

            let text = "";

            // ==========================================
            // PDF
            // ==========================================

            if (
                extension === ".pdf"
            ) {
                const buffer =
                    fs.readFileSync(
                        tempPath
                    );

                const parsed =
                    await pdfParse(
                        buffer
                    );

                text =
                    parsed.text ||
                    "";
            }

            // ==========================================
            // DOCX
            // ==========================================

            else if (
                extension === ".docx"
            ) {
                const result =
                    await mammoth.extractRawText(
                        {
                            path:
                                tempPath
                        }
                    );

                text =
                    result.value ||
                    "";
            }

            // ==========================================
            // NORMAL TEXT FILES
            // ==========================================

            else {
                text =
                    fs.readFileSync(
                        tempPath,
                        "utf8"
                    );
            }

            // ==========================================
            // CHECK EMPTY
            // ==========================================

            if (
                !text.trim()
            ) {
                return res
                    .status(422)
                    .json({
                        success:
                            false,

                        error:
                            "No readable text was found in this file."
                    });
            }

            // ==========================================
            // RETURN FILE CONTENT
            // ==========================================

            return res.json({
                success:
                    true,

                filename:
                    originalName,

                text:
                    text.slice(
                        0,
                        60000
                    )
            });

        } catch (error) {

            console.error(
                "❌ File extraction error:",
                error?.message ||
                    error
            );

            return res
                .status(500)
                .json({
                    success:
                        false,

                    error:
                        "Could not extract text from this file."
                });

        } finally {

            // ==========================================
            // DELETE TEMP FILE
            // ==========================================

            if (tempPath) {
                try {
                    fs.unlinkSync(
                        tempPath
                    );
                } catch {
                    // Ignore cleanup errors.
                }
            }
        }
    }
);

// ======================================================
// SERVE FRONTEND
// ======================================================

const frontendPath =
    path.join(
        __dirname,
        "../Frontend"
    );

app.use(
    express.static(
        frontendPath
    )
);

app.get(
    "/",
    (req, res) => {
        res.sendFile(
            path.join(
                frontendPath,
                "index.html"
            )
        );
    }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            "============================================"
        );

        console.log(
            "             🤖 AI CHATBOT"
        );

        console.log(
            "============================================"
        );

        console.log(
            `Server       : http://localhost:${PORT}`
        );

        console.log(
            `Health       : http://localhost:${PORT}/health`
        );

        console.log(
            "AI Provider  : OpenRouter"
        );

        console.log(
            "Framework    : LangChain.js"
        );

        console.log(
            `Model        : ${MODEL}`
        );

        console.log(
            `Serper keys  : ${SERPER_API_KEYS.length}`
        );

        console.log(
            "Fallback     : OpenRouter → Serper"
        );

        console.log(
            "Key rotation : Key 1 → Key 2 → Key 3"
        );

        console.log(
            "Text         : ✅"
        );

        console.log(
            "Images       : ✅"
        );

        console.log(
            "Files        : ✅"
        );

        console.log(
            "Voice input  : ✅ Browser"
        );

        console.log(
            "Text speech  : ✅ Browser"
        );

        console.log(
            "============================================"
        );
    }
);