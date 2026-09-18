import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as connections from "../services/connections.service";
import * as secrets from "../services/secrets.service";
import { stopAllGenerations, stopGenerationSweep } from "../services/generate.service";
import { clearAllPoolEntries, stopPoolSweep } from "../services/generation-pool.service";
import { WorkerHost } from "./worker-host";

const userId = "quiet-session-test";
const sent: Record<string, any>[] = [];
const routing = { order: ["deepseek", "z-ai"], allow_fallbacks: false };
let connectionId: string;
let directConnectionId: string;
let secretSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  secretSpy = spyOn(secrets, "getSecret").mockResolvedValue("synthetic-test-key");
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    return body.stream
      ? new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      })
      : Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  }) as typeof fetch);
  const profile = await connections.createConnection(userId, {
    name: "Quiet session test", provider: "openrouter", model: "z-ai/glm-5.3-flash",
    metadata: { openrouter: { provider_routing: routing } },
  });
  connectionId = profile.id;
  directConnectionId = (await connections.createConnection(userId, {
    name: "Direct provider", provider: "openai", model: "test-model",
  })).id;
});

afterAll(() => {
  stopAllGenerations();
  stopGenerationSweep();
  stopPoolSweep();
  clearAllPoolEntries();
  secretSpy?.mockRestore();
  fetchSpy?.mockRestore();
  closeDatabase();
});

async function request(stream: boolean, input: Record<string, unknown>) {
  const posted: any[] = [];
  const host = Object.assign(Object.create(WorkerHost.prototype), {
    manifest: { name: "Session test", identifier: "session_test" }, extensionId: "test-extension",
    generationAbortControllers: new Map(), hasPermission: () => true,
    resolveEffectiveUserId: () => userId, enforceScopedUser: () => {},
    postToWorker: (message: unknown) => posted.push(message),
  });
  const before = sent.length;
  const args = {
    type: "quiet", userId, connection_id: connectionId,
    messages: [{ role: "user", content: "Synthetic session test." }],
    reasoning: { source: "off" },
    ...input,
  };
  if (stream) await host.handleGenerationStream("quiet-session", args);
  else await host.handleGeneration("quiet-session", args);
  expect(posted.find((message) => message.error)).toBeUndefined();
  expect(sent).toHaveLength(before + 1);
  return sent.at(-1)!;
}

for (const stream of [false, true]) {
  const mode = stream ? "streaming" : "regular";
  test(`${mode} quiet requests retain routing and use the main chat session format`, async () => {
    for (const chatId of ["chat-a", "chat-b"]) {
      const body = await request(stream, {
        chat_id: chatId,
        parameters: { tool_choice: "required" },
        tools: [{ name: "lumi_mind_analysis_v1", parameters: { type: "object" } }],
      });
      expect(body.session_id).toBe(`lumiverse:${chatId}`);
      expect(body.provider).toEqual(routing);
      expect(body.tool_choice).toBe("required");
      expect(body).not.toHaveProperty("chat_id");
    }
  });

  test(`${mode} quiet requests without a chat do not invent a session`, async () => {
    expect(await request(stream, {})).not.toHaveProperty("session_id");
  });

  test(`${mode} quiet requests preserve an explicit session`, async () => {
    const body = await request(stream, { chat_id: "chat-a", parameters: { session_id: "custom-session" } });
    expect(body.session_id).toBe("custom-session");
  });

  test(`${mode} quiet requests preserve an explicit cache key`, async () => {
    const body = await request(stream, { chat_id: "chat-a", parameters: { prompt_cache_key: "custom-cache" } });
    expect(body.prompt_cache_key).toBe("custom-cache");
    expect(body).not.toHaveProperty("session_id");
  });

  test(`${mode} direct provider requests do not receive OpenRouter sessions`, async () => {
    const body = await request(stream, { chat_id: "chat-a", connection_id: directConnectionId });
    expect(body).not.toHaveProperty("session_id");
  });
}
