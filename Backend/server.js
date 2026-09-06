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

const OPENROUTER_API_KEY =
    process.env.OPENROUTER_API_KEY;

// ======================================================
// ONE MODEL FOR EVERYTHING
// ======================================================

const MODEL =
    "minimax/minimax-m3:free";

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

const uploadDirectory =
    path.join(
        __dirname,
        "tmp_uploads"
    );

if (!fs.existsSync(uploadDirectory)) {
    fs.mkdirSync(
        uploadDirectory,
        {
            recursive: true
        }
    );
}

const upload =
    multer({
        dest: uploadDirectory,

        limits: {
            fileSize:
                12 * 1024 * 1024
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

// ======================================================
// CREATE MINIMAX MODEL
// ======================================================

const aiModel =
    new ChatOpenAI({

        model: MODEL,

        apiKey:
            OPENROUTER_API_KEY,

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
// SYSTEM PROMPT
// ======================================================

const systemMessage = {

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

Do not claim to see or access something that was not provided.

Do not invent facts.

Be helpful, concise and clear.
`
};

// ======================================================
// HELPERS
// ======================================================

function normalizeReply(content) {

    if (
        typeof content ===
        "string"
    ) {

        return content;

    }

    if (
        Array.isArray(content)
    ) {

        return content
            .map(part => {

                if (
                    typeof part ===
                    "string"
                ) {
                    return part;
                }

                if (
                    part &&
                    typeof part.text ===
                    "string"
                ) {
                    return part.text;
                }

                return "";

            })
            .join("");

    }

    if (
        content &&
        typeof content.text ===
        "string"
    ) {

        return content.text;

    }

    return "";

}

// ======================================================
// VALIDATE CHAT MESSAGES
// ======================================================

function sanitizeMessages(messages) {

    if (
        !Array.isArray(messages)
    ) {

        return [];

    }

    return messages
        .filter(message => {

            if (
                !message ||
                ![
                    "user",
                    "assistant",
                    "system"
                ].includes(
                    message.role
                )
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
// CHECK FOR IMAGE
// ======================================================

function containsImage(messages) {

    return messages.some(
        message => {

            if (
                !Array.isArray(
                    message?.content
                )
            ) {

                return false;

            }

            return message.content.some(
                part =>
                    part?.type ===
                    "image_url"
            );

        }
    );

}

// ======================================================
// CHECK RATE LIMIT
// ======================================================

function isRateLimitError(error) {

    const status =
        error?.status ||
        error?.statusCode ||
        error?.response?.status;

    const message =
        String(
            error?.message ||
            error ||
            ""
        ).toLowerCase();

    return (
        Number(status) === 429 ||
        message.includes("429") ||
        message.includes(
            "rate limit"
        ) ||
        message.includes(
            "rate_limit"
        ) ||
        message.includes(
            "model_rate_limit"
        ) ||
        message.includes(
            "too many requests"
        )
    );

}

// ======================================================
// WAIT
// ======================================================

function wait(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );

}

// ======================================================
// CALL MINIMAX
// ======================================================

async function callMiniMax(
    messages
) {

    const maxAttempts = 3;

    for (
        let attempt = 1;
        attempt <= maxAttempts;
        attempt++
    ) {

        try {

            console.log(
                `🤖 MiniMax M3 request ${attempt}/${maxAttempts}`
            );

            const response =
                await aiModel.invoke(
                    messages
                );

            return response;

        } catch (error) {

            console.error(
                `MiniMax attempt ${attempt} failed:`,
                error?.message ||
                    error
            );

            if (
                !isRateLimitError(error) ||
                attempt === maxAttempts
            ) {

                throw error;

            }

            const delay =
                attempt === 1
                    ? 2000
                    : 5000;

            console.log(
                `⏳ MiniMax rate-limited. Retrying in ${delay / 1000}s...`
            );

            await wait(delay);

        }

    }

    throw new Error(
        "MiniMax request failed."
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

            model:
                MODEL,

            imageSupport:
                true

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

            // ------------------------------------------
            // CHECK API KEY
            // ------------------------------------------

            if (
                !OPENROUTER_API_KEY
            ) {

                return res
                    .status(500)
                    .json({

                        success: false,

                        error:
                            "OPENROUTER_API_KEY is missing in Backend/.env"

                    });

            }

            // ------------------------------------------
            // GET MESSAGES
            // ------------------------------------------

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

                        success: false,

                        error:
                            "No valid messages were provided."

                    });

            }

            // ------------------------------------------
            // IMAGE DETECTION
            // ------------------------------------------

            const imageRequest =
                containsImage(
                    safeMessages
                );

            if (imageRequest) {

                console.log(
                    "🖼️ Image detected"
                );

                console.log(
                    "Using MiniMax M3 multimodal input"
                );

            } else {

                console.log(
                    "💬 Text request detected"
                );

            }

            // ------------------------------------------
            // BUILD FINAL MESSAGES
            // ------------------------------------------

            const finalMessages = [
                systemMessage,
                ...safeMessages
            ];

            // ------------------------------------------
            // CALL MINIMAX
            // ------------------------------------------

            const response =
                await callMiniMax(
                    finalMessages
                );

            // ------------------------------------------
            // GET RESPONSE TEXT
            // ------------------------------------------

            const reply =
                normalizeReply(
                    response?.content
                ).trim();

            if (!reply) {

                throw new Error(
                    "MiniMax returned an empty response."
                );

            }

            // ------------------------------------------
            // RETURN RESPONSE
            // ------------------------------------------

            return res.json({

                success: true,

                reply,

                modelUsed:
                    MODEL,

                provider:
                    "OpenRouter",

                framework:
                    "LangChain.js",

                multimodal:
                    imageRequest

            });

        } catch (error) {

            console.error(
                "❌ MiniMax error:",
                error?.message ||
                    error
            );

            const rateLimited =
                isRateLimitError(
                    error
                );

            return res
                .status(
                    rateLimited
                        ? 429
                        : 500
                )
                .json({

                    success: false,

                    error:
                        rateLimited
                            ? "MiniMax M3 is currently rate-limited. Please wait a few seconds and try again."
                            : (
                                error?.message ||
                                "Failed to get a response from MiniMax M3."
                              )

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

                        success: false,

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

            // ------------------------------------------
            // PDF
            // ------------------------------------------

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
                    parsed.text || "";

            }

            // ------------------------------------------
            // DOCX
            // ------------------------------------------

            else if (
                extension === ".docx"
            ) {

                const result =
                    await mammoth.extractRawText({
                        path:
                            tempPath
                    });

                text =
                    result.value || "";

            }

            // ------------------------------------------
            // NORMAL TEXT FILE
            // ------------------------------------------

            else {

                text =
                    fs.readFileSync(
                        tempPath,
                        "utf8"
                    );

            }

            // ------------------------------------------
            // CHECK EMPTY
            // ------------------------------------------

            if (
                !text.trim()
            ) {

                return res
                    .status(422)
                    .json({

                        success: false,

                        error:
                            "No readable text was found in this file."

                    });

            }

            // ------------------------------------------
            // RETURN TEXT
            // ------------------------------------------

            return res.json({

                success: true,

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

                    success: false,

                    error:
                        "Could not extract text from this file."

                });

        } finally {

            if (tempPath) {

                try {

                    fs.unlinkSync(
                        tempPath
                    );

                } catch {}

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

// ======================================================
// HOME PAGE
// ======================================================

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
            "        🤖 AI CHATBOT"
        );

        console.log(
            "============================================"
        );

        console.log(
            `Server       : http://localhost:${PORT}`
        );

        console.log(
            `Health       : /health`
        );

        console.log(
            `AI Provider  : OpenRouter`
        );

        console.log(
            `Framework    : LangChain.js`
        );

        console.log(
            `Model        : minimax/minimax-m3:free`
        );

        console.log(
            `Text         : ✅`
        );

        console.log(
            `Images       : ✅`
        );

        console.log(
            `Files        : ✅`
        );

        console.log(
            `Voice input  : ✅ Browser`
        );

        console.log(
            `Text speech  : ✅ Browser`
        );

        console.log(
            "============================================"
        );
    }
);