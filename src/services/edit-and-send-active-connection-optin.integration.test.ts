/**
 * Task 3.18 — dispatch-time resolution and safe degradation, end to end through
 * the real outbox.
 *
 * What this suite proves that the unit and property suites cannot:
 *   - the dispatcher really does forward `{ origin: "edit_and_send" }` as a
 *     second positional argument on ALL THREE dispatch paths — the POST-handler
 *     path (`dispatchEditAndSendRequest`), the periodic retry tick
 *     (`dispatchPendingEditAndSendOutbox`), and startup recovery
 *     (`recoverEditAndSendOutbox`);
 *   - the setting is read at DISPATCH time, not captured at request time —
 *     shown by flipping the persisted value to `false` BETWEEN the commit and
 *     the retry-tick dispatch and observing the dispatch follow the new value;
 *   - safe degradation (2.14): setting on, binding live, `activeProfileId`
 *     naming a deleted profile resolves the BOUND profile, starts, and reaches
 *     `running` — no throw, no `failed`, no `terminal_reason`;
 *   - the acting-connection fix itself lands through the whole flow for both
 *     `branchChatOnEditAndSend` values.
 *
 * Harness note: the injected `setEditAndSendStartGeneration` seam delegates to
 * the REAL `startGeneration`, forwarding the options it was handed, so the real
 * dispatch-time settings read and the real resolution ladder run. Only the
 * detached prompt-assembly failure is swallowed (council profile resolution is
 * stubbed to throw so nothing reaches a provider), and the seam then reports the
 * success the row would have seen. The connection identity under test is never
 * stubbed.
 *
 * This suite creates `settings` and `connection_profiles` in ITS OWN harness.
 * The existing dispatcher harnesses deliberately create neither, because the
 * dispatcher itself queries nothing.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { closeDatabase, getDb, initDatabase } from "../db/connection";

mock.module("../crypto/init", () => ({
  getEncryptionKeyBytes: () => new Uint8Array(32).fill(7),
}));

const chatsSvc = await import("./chats.service");
const chatBackground = await import("./chat-background.service");
const councilProfilesSvc = await import("./council/council-profiles.service");
const pool = await import("./generation-pool.service");
const generateSvc = await import("./generate.service");
const dispatcher = await import("./edit-and-send-dispatcher.service");

const USER = "user:optin-integration";

const ACTIVE = "int-active";
const DEFAULT = "int-default";
const BOUND = "int-bound";
const BINDING_MODEL_OVERRIDE = "binding-model-override";

// ── Fixture ────────────────────────────────────────────────────────────────

function initTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '', scenario TEXT NOT NULL DEFAULT '', first_mes TEXT NOT NULL DEFAULT '',
    mes_example TEXT NOT NULL DEFAULT '', creator TEXT NOT NULL DEFAULT '', creator_notes TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '', post_history_instructions TEXT NOT NULL DEFAULT '', avatar_path TEXT,
    image_id TEXT, tags TEXT NOT NULL DEFAULT '[]', alternate_greetings TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY, user_id TEXT, character_id TEXT, name TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, index_in_chat INTEGER NOT NULL, is_user INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', send_date INTEGER NOT NULL, swipe_id INTEGER NOT NULL DEFAULT 0,
    swipes TEXT NOT NULL DEFAULT '[]', swipe_dates TEXT NOT NULL DEFAULT '[]', extra TEXT NOT NULL DEFAULT '{}',
    parent_message_id TEXT, branch_id TEXT, created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE TABLE chat_memory_cache (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, settings_key TEXT NOT NULL,
    source_message_count INTEGER NOT NULL DEFAULT 0, query_preview TEXT NOT NULL DEFAULT '', chunks_json TEXT NOT NULL DEFAULT '[]',
    formatted TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    settings_source TEXT NOT NULL DEFAULT 'global', chunks_available INTEGER NOT NULL DEFAULT 0,
    chunks_pending INTEGER NOT NULL DEFAULT 0, retrieval_mode TEXT NOT NULL DEFAULT 'empty', created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, UNIQUE(chat_id, settings_key)
  )`);
  db.run(`CREATE TABLE edit_and_send_requests (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL, branch_chat_id TEXT NOT NULL, edited_message_id TEXT NOT NULL,
    target_message_id TEXT, target_swipe_index INTEGER, generation_id TEXT NOT NULL, response TEXT NOT NULL,
    cursor TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (user_id, chat_id, request_id)
  )`);
  db.run(`CREATE TABLE generation_outbox (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    branch_chat_id TEXT NOT NULL, edited_message_id TEXT NOT NULL, target_message_id TEXT, target_swipe_index INTEGER,
    expected_version INTEGER NOT NULL, generation_id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL CHECK(mode IN ('normal', 'swipe')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
    lease_owner TEXT, lease_expires_at INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
    last_error_code TEXT, terminal_reason TEXT, dispatched_at INTEGER, completed_at INTEGER, cancelled_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL, value TEXT NOT NULL, user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, user_id)
  )`);
  db.run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, api_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '', preset_id TEXT, is_default INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1,
    has_api_key INTEGER NOT NULL DEFAULT 0, user_id TEXT
  )`);
  db.run(`CREATE TABLE secrets (
    key TEXT NOT NULL, encrypted_value TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL,
    user_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, user_id)
  )`);
  getDb().query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)")
    .run("char-int", USER, "Integration");
}

/** Keyless `custom` profiles: the credential preflight is not what this suite tests. */
function seedProfile(id: string, model: string, isDefault = false): void {
  getDb().query(
    `INSERT INTO connection_profiles
       (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
     VALUES (?, ?, 'custom', 'http://127.0.0.1:1234/v1', ?, NULL, ?, '{}', 1, 1, 0, ?)`,
  ).run(id, id, model, isDefault ? 1 : 0, USER);
}

function seedSetting(key: string, value: unknown): void {
  getDb().query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 1)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value), USER);
}

function seedChat(id: string, metadata: Record<string, unknown> = {}): void {
  getDb().query(
    "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)",
  ).run(id, USER, "char-int", id, JSON.stringify({ temporary: true, no_preset: true, ...metadata }));
}

function seedUserMessage(chatId: string): string {
  const id = `${chatId}-user`;
  getDb().query(`INSERT INTO messages (
    id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra,
    parent_message_id, branch_id, created_at, revision
  ) VALUES (?, ?, 0, 1, 'User', 'original', 100, 0, ?, ?, '{}', NULL, NULL, 100, 2)`).run(
    id, chatId, JSON.stringify(["original"]), JSON.stringify([100]),
  );
  return id;
}

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

interface DispatchObservation {
  /** The second positional argument the dispatcher handed `startGeneration`. */
  options: { origin?: string } | undefined;
  /** The connection id the REAL resolution ladder settled on. */
  connectionId: string | undefined;
  /** The model the pool entry was registered with, when it got that far. */
  model: string | undefined;
}

/**
 * Install the dispatcher seam so it delegates to the real `startGeneration`,
 * forwarding the options it received. Prompt assembly is stubbed to throw, so
 * nothing reaches a provider; the seam reports the success the outbox row would
 * have seen, leaving the row's state machine to behave normally.
 */
function observeRealDispatches(): DispatchObservation[] {
  const observed: DispatchObservation[] = [];
  track(spyOn(chatBackground, "abortChatBackground").mockResolvedValue(undefined));
  track(spyOn(councilProfilesSvc, "resolveProfile").mockImplementation(() => {
    throw new Error("skip-assembly");
  }));
  dispatcher.setEditAndSendStartGeneration(async (input, options) => {
    await generateSvc.startGeneration(input as never, options)
      .catch(() => { /* the stubbed prompt assembly, not the resolution */ });
    observed.push({
      options,
      connectionId: (input as { connection_id?: string }).connection_id,
      model: pool.getPoolEntry(input.generationId)?.model,
    });
    // Between paths, clear the in-memory generation state so a later dispatch
    // of a different row is resolved afresh rather than short-circuiting on a
    // live pool entry.
    generateSvc.stopAllGenerations();
    pool.clearAllPoolEntries();
    return { generationId: input.generationId, status: "streaming" };
  });
  return observed;
}

/** Commit an Edit-and-Send request; returns its request id. */
function commitEditAndSend(chatId: string, branch: boolean): string {
  const requestId = `${chatId}-request`;
  const result = chatsSvc.editAndSend(USER, chatId, {
    messageId: `${chatId}-user`,
    content: "rewritten",
    expectedVersion: 2,
    requestId,
    branchChatOnEditAndSend: branch,
  });
  expect(result.status).toBe("ok");
  return requestId;
}

beforeEach(() => {
  initTestDb();
  dispatcher.resetEditAndSendDispatcherForTests();
  seedProfile(ACTIVE, "model-active");
  seedProfile(DEFAULT, "model-default", true);
  seedProfile(BOUND, "model-bound");
  seedSetting("activeProfileId", ACTIVE);
});

afterEach(() => {
  generateSvc.stopAllGenerations();
  pool.clearAllPoolEntries();
  generateSvc.stopGenerationSweep();
  dispatcher.resetEditAndSendDispatcherForTests();
  for (const spy of spies.splice(0)) spy.mockRestore();
  closeDatabase();
});

// ── Dispatch-time resolution on all three paths ────────────────────────────

describe("the opt-in resolves at dispatch time on all three dispatch paths", () => {
  test("POST handler, retry tick, and startup recovery all resolve the ACTIVE profile", async () => {
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    const observed = observeRealDispatches();

    // (a) The POST-handler path.
    seedChat("path-a", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("path-a");
    const requestA = commitEditAndSend("path-a", false);
    const rowA = await dispatcher.dispatchEditAndSendRequest(USER, "path-a", requestA);

    // (b) The periodic retry tick: the row is committed `pending` and never
    // dispatched from the handler, exactly as a deferred dispatch would be.
    seedChat("path-b", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("path-b");
    commitEditAndSend("path-b", false);
    expect(await dispatcher.dispatchPendingEditAndSendOutbox()).toBe(1);

    // (c) Startup recovery.
    seedChat("path-c", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("path-c");
    commitEditAndSend("path-c", false);
    expect(await dispatcher.recoverEditAndSendOutbox()).toBe(1);

    expect(observed.map((entry) => ({
      origin: entry.options?.origin,
      connectionId: entry.connectionId,
      model: entry.model,
    }))).toEqual([
      { origin: "edit_and_send", connectionId: ACTIVE, model: "model-active" },
      { origin: "edit_and_send", connectionId: ACTIVE, model: "model-active" },
      { origin: "edit_and_send", connectionId: ACTIVE, model: "model-active" },
    ]);
    expect(rowA?.status).toBe("running");
  });

  test("flipping the setting to false BETWEEN commit and the retry tick changes the dispatch", async () => {
    // The observable proof that the value is read at dispatch time rather than
    // captured at request time — and therefore the reason no `generation_outbox`
    // column is needed.
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    const observed = observeRealDispatches();

    seedChat("flip", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("flip");
    commitEditAndSend("flip", false);

    // Mid-flight: the user unticks the checkbox after committing the edit but
    // before the deferred dispatch runs.
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: false });

    expect(await dispatcher.dispatchPendingEditAndSendOutbox()).toBe(1);
    expect(observed.map((entry) => ({ connectionId: entry.connectionId, model: entry.model }))).toEqual([
      { connectionId: BOUND, model: BINDING_MODEL_OVERRIDE },
    ]);
  });
});

// ── Safe degradation (2.14) ────────────────────────────────────────────────

describe("safe degradation when the active profile cannot be resolved", () => {
  test("setting on, binding live, activeProfileId deleted: resolves the BOUND profile and runs", async () => {
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    seedSetting("activeProfileId", "int-deleted-never-existed");
    const observed = observeRealDispatches();

    seedChat("degrade", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("degrade");
    const requestId = commitEditAndSend("degrade", false);
    const row = await dispatcher.dispatchEditAndSendRequest(USER, "degrade", requestId);

    expect(observed.map((entry) => ({ connectionId: entry.connectionId, model: entry.model }))).toEqual([
      { connectionId: BOUND, model: BINDING_MODEL_OVERRIDE },
    ]);
    // No throw, no failed row, no terminal reason for that reason alone.
    expect({
      status: row?.status,
      terminalReason: row?.terminal_reason,
      lastErrorCode: row?.last_error_code,
      dispatchedAtSet: row?.dispatched_at != null,
    }).toEqual({
      status: "running",
      terminalReason: null,
      lastErrorCode: null,
      dispatchedAtSet: true,
    });
  });
});

// ── The acting-connection fix through the whole flow ───────────────────────

describe("the Edit-and-Send flow starts on the acting connection", () => {
  for (const branch of [false, true]) {
    test(`activeProfileId != is_default, no binding, branchChatOnEditAndSend = ${branch}`, async () => {
      // No `quickToolbarSettings` row at all — the state every existing user is
      // in. This is the 401 fix on its own, with the opt-in absent.
      const observed = observeRealDispatches();

      const chatId = `flow-${branch}`;
      seedChat(chatId);
      seedUserMessage(chatId);
      const requestId = commitEditAndSend(chatId, branch);
      const row = await dispatcher.dispatchEditAndSendRequest(USER, chatId, requestId);

      expect(observed.map((entry) => ({ connectionId: entry.connectionId, model: entry.model }))).toEqual([
        { connectionId: ACTIVE, model: "model-active" },
      ]);
      expect({
        status: row?.status,
        attemptCount: row?.attempt_count,
        dispatchedAtSet: row?.dispatched_at != null,
        terminalReason: row?.terminal_reason,
      }).toEqual({
        status: "running",
        // `running` reached exactly once: one claim, one dispatch, no retry.
        attemptCount: 1,
        dispatchedAtSet: true,
        terminalReason: null,
      });

      // A replayed dispatch is idempotent and does not re-resolve.
      await dispatcher.dispatchEditAndSendRequest(USER, chatId, requestId);
      expect(observed).toHaveLength(1);
    });
  }
});
