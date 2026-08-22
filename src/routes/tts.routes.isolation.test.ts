import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ttsConnectionsRoutes } from "./tts-connections.routes";
import { getTtsProvider, getTtsProviderList } from "../tts/registry";
import { providerRegistry } from "../spindle/provider-registry";

const ALICE = "alpha-id";
const BOB = "beta-id";

function app(userId: string) {
  const instance = new Hono();
  instance.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  instance.route("/", ttsConnectionsRoutes);
  return instance;
}

async function listedProviderIds(userId: string): Promise<string[]> {
  const response = await app(userId).request("/providers");
  const body = await response.json() as { providers: Array<{ id: string }> };
  return body.providers.map((provider) => provider.id);
}

afterEach(() => providerRegistry.reset());

describe("tts routes multi-tenant isolation", () => {
  test("private providers are visible only to their owner while system providers are shared", async () => {
    providerRegistry.register(
      { kind: "tts", id: "alice-private" },
      { installationId: "inst-alice", installScope: "user", authenticatedSubject: ALICE },
    );
    providerRegistry.register(
      { kind: "tts", id: "system-shared" },
      { installationId: "inst-system", installScope: "system" },
    );

    expect(await listedProviderIds(ALICE)).toEqual(expect.arrayContaining(["alice-private", "system-shared"]));
    expect(await listedProviderIds(BOB)).not.toContain("alice-private");
    expect(await listedProviderIds(BOB)).toContain("system-shared");
    expect(getTtsProvider("alice-private", BOB)).toBeUndefined();
    expect(getTtsProvider("alice-private", ALICE)).toBeDefined();
  });

  test("an omitted caller never falls back to an all-tenant sweep", () => {
    providerRegistry.register(
      { kind: "tts", id: "alice-private" },
      { installationId: "inst-alice", installScope: "user", authenticatedSubject: ALICE },
    );
    expect(getTtsProviderList().map((provider) => provider.name)).not.toContain("alice-private");
  });
});
