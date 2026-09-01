import 'dotenv/config'
import http from "http";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import { client } from '@repo/redis';
import { prisma } from "@repo/db";

interface InterviewType {
  InterviewID: string,
  Messages: Messagetype[],
}

interface Messagetype {
  Sender: "AI" | "CLIENT",
  Messages: string,
  createdAt: Date
}

type InterviewLifecycle =
  | "Running"
  | "AIResponding"
  | "GoodbyePending"
  | "GoodbyePlaying"
  | "Finished";

const GOODBYE_PROMPT =
  "The interview time has ended. Thank the candidate politely and end the interview. Do not ask another question.";

const GOODBYE_PLAYING_TIMEOUT_MS = 30_000;
const GOODBYE_PENDING_TIMEOUT_MS = 90_000;

const PORT = Number(process.env.PORT) || 5050;

const healthServer = http.createServer(async (req, res) => {
  const path = (req.url || "").split("?")[0];

  if (req.method !== "GET" || path !== "/health") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not found" }));
    return;
  }

  const startedAt = Date.now();
  let database: "up" | "down" = "up";
  let redis: "up" | "down" = "up";

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    database = "down";
    console.error("Health check: database unreachable", error);
  }

  try {
    await client.ping();
  } catch (error) {
    redis = "down";
    console.error("Health check: redis unreachable", error);
  }

  const healthy = database === "up" && redis === "up";

  res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: healthy ? "ok" : "degraded",
    service: "websocket",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    activeConnections: wss.clients.size,
    checks: {
      database,
      redis
    }
  }));
});

const wss = new WebSocketServer({
  server: healthServer,
});

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

wss.on("connection", async (socket, req) => {
  let lifecycle: InterviewLifecycle = "Running";
  let goodbyeSent = false;
  let finalizing = false;
  let aimessage = "";
  let goodbyePlayingTimeout: ReturnType<typeof setTimeout> | null = null;
  let goodbyePendingTimeout: ReturnType<typeof setTimeout> | null = null;

  const InterviewMessages: Messagetype[] = [];

  console.log("Frontend connected");

  const url = new URL(req.url!, "http://localhost");
  const interviewIdParam = url.searchParams.get("interviewId");
  const role = url.searchParams.get("role") || "General";

  if (!interviewIdParam) {
    return;
  }

  const interviewId = interviewIdParam;

  const githubmetadata = await prisma.interview.findUnique({
    where: {
      id: interviewId
    }
  });

  function InterviewMaker() {
    const finalPrompt = `You are a senior level ${role} at a software company. You need to take a ${role} interview ${process.env.GEMINI_PROMPT!}. - The Interview will have three phases 
                - first phase contains general questions about the candidate like tell me something about yourself.
                - second phase contains personalized questions based on the candidate's github.The user's githubdata ${JSON.stringify(githubmetadata)}.Ask questions from atleast 2 of his projects.
                - third phase contains personalized questions based on the candidate's resume`
    return finalPrompt
  }

  function clearGoodbyeTimeouts() {
    if (goodbyePlayingTimeout) {
      clearTimeout(goodbyePlayingTimeout);
      goodbyePlayingTimeout = null;
    }
    if (goodbyePendingTimeout) {
      clearTimeout(goodbyePendingTimeout);
      goodbyePendingTimeout = null;
    }
  }

  function startGoodbyePlayingTimeout() {
    if (goodbyePlayingTimeout) {
      clearTimeout(goodbyePlayingTimeout);
    }
    goodbyePlayingTimeout = setTimeout(() => {
      if (lifecycle === "GoodbyePlaying") {
        console.warn("Goodbye turnComplete timeout — finalizing interview anyway", interviewId);
        void finalizeInterview();
      }
    }, GOODBYE_PLAYING_TIMEOUT_MS);
  }

  function startGoodbyePendingTimeout() {
    if (goodbyePendingTimeout) {
      clearTimeout(goodbyePendingTimeout);
    }
    goodbyePendingTimeout = setTimeout(() => {
      if (lifecycle === "GoodbyePending") {
        console.warn("Goodbye pending timeout — sending goodbye prompt", interviewId);
        sendGoodbyePrompt();
      }
    }, GOODBYE_PENDING_TIMEOUT_MS);
  }

  function sendGoodbyePrompt() {
    if (goodbyeSent || lifecycle === "Finished") {
      return;
    }
    goodbyeSent = true;
    lifecycle = "GoodbyePlaying";
    clearGoodbyeTimeouts();
    startGoodbyePlayingTimeout();

    session.sendClientContent({
      turns: [{
        role: "user",
        parts: [{
          text: GOODBYE_PROMPT
        }]
      }],
      turnComplete: true
    });
  }

  function requestInterviewEnd() {
    if (
      lifecycle === "Finished" ||
      lifecycle === "GoodbyePending" ||
      lifecycle === "GoodbyePlaying"
    ) {
      return;
    }

    if (lifecycle === "AIResponding") {
      lifecycle = "GoodbyePending";
      startGoodbyePendingTimeout();
      return;
    }

    sendGoodbyePrompt();
  }

  async function persistCompletedAiTurn() {
    if (!aimessage) {
      return;
    }

    InterviewMessages.push({
      Sender: "AI",
      Messages: aimessage,
      createdAt: new Date()
    });

    await client.rpush(
      `interview:${interviewId}:messages`,
      JSON.stringify({
        sender: "AI",
        message: aimessage,
        createdAt: new Date()
      })
    );

    aimessage = "";
  }

  async function finalizeInterview() {
    if (finalizing || lifecycle === "Finished") {
      return;
    }
    finalizing = true;
    lifecycle = "Finished";
    clearGoodbyeTimeouts();

    if (aimessage) {
      await persistCompletedAiTurn();
    }

    await prisma.messages.createMany({
      data: InterviewMessages.map(msg => ({
        interviewid: interviewId,
        messages: msg.Messages,
        sentAt: msg.createdAt,
        type: msg.Sender === "AI"
          ? "AIassistent"
          : "User"
      }))
    });

    try {
      await client.rpush(
        "interview-rating-queue",
        interviewId
      );
      console.log("pushed interview ID to queue", interviewId);
    } catch (error) {
      console.log(error);
    }

    await client.del(`interview:${interviewId}:messages`);

    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({
        type: "Interview ended"
      }));
    }

    session.close();
    socket.close();
  }

  async function handleTurnComplete() {
    await persistCompletedAiTurn();

    if (socket.readyState === socket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "Message list",
          data: InterviewMessages
        })
      );
    }

    if (lifecycle === "GoodbyePlaying") {
      await finalizeInterview();
      return;
    }

    if (lifecycle === "GoodbyePending") {
      sendGoodbyePrompt();
      return;
    }

    if (lifecycle === "AIResponding") {
      lifecycle = "Running";
    }
  }

  const session = await ai.live.connect({
    model: "gemini-3.1-flash-live-preview",
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: InterviewMaker()
    },

    callbacks: {
      onopen() {
        console.log("Gemini connected");
      },

      async onmessage(message) {
        const content = message.serverContent;
        if (!content || lifecycle === "Finished") {
          return;
        }

        if (content.inputTranscription?.text) {
          InterviewMessages.push({
            Sender: "CLIENT",
            Messages: content.inputTranscription.text,
            createdAt: new Date()
          });
          await client.rpush(
            `interview:${interviewId}:messages`,
            JSON.stringify({
              sender: "CLIENT",
              message: content.inputTranscription.text,
              createdAt: new Date()
            })
          );
        }

        const hasAiOutput = Boolean(
          content.modelTurn?.parts?.some(part => part.inlineData) ||
          content.outputTranscription?.text
        );

        if (
          hasAiOutput &&
          (lifecycle === "Running" || lifecycle === "AIResponding")
        ) {
          lifecycle = "AIResponding";
        }

        if (content?.modelTurn?.parts) {
          for (const part of content.modelTurn.parts) {
            if (part.inlineData) {
              socket.send(
                JSON.stringify({
                  type: "audio",
                  data: part.inlineData.data
                })
              );
            }
          }
        }

        if (content?.outputTranscription?.text) {
          aimessage = aimessage + content.outputTranscription.text;

          socket.send(
            JSON.stringify({
              type: "transcript",
              text: content.outputTranscription.text
            })
          );
        }

        if (content.turnComplete) {
          await handleTurnComplete();
        }
      },

      onerror(error) {
        console.error("Gemini error:", error);
      },

      onclose(event) {
        console.log("Gemini closed:", event.reason);
      },
    },
  });

  console.log("Gemini session started");

  socket.on("message", (data, isBinary) => {
    if (lifecycle === "Finished") {
      return;
    }

    if (!isBinary) {
      const msg = JSON.parse(data.toString());
      if (msg.type === "End Call") {
        requestInterviewEnd();
      }
      return;
    }

    const buffer = data as Buffer;
    session.sendRealtimeInput({
      audio: {
        data: buffer.toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    });
  });

  socket.on("close", () => {
    console.log("Frontend disconnected");
    clearGoodbyeTimeouts();
    if (lifecycle !== "Finished") {
      lifecycle = "Finished";
      session.close();
    }
  });

  socket.on("error", (err) => {
    console.error(err);
    clearGoodbyeTimeouts();
    if (lifecycle !== "Finished") {
      lifecycle = "Finished";
      session.close();
    }
  });
});

healthServer.listen(PORT, () => {
  console.log(`Websocket listening on ${PORT}`);
});
