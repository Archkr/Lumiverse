import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sttConnectionsRoutes } from "./stt-connections.routes";
import { getProvider, listProviders } from "../services/stt-connections.service";
import { providerRegistry } from "../spindle/provider-registry";

const ALICE = "alpha-id";
const BOB = "beta-id";

function app(userId: string) {
  const instance = new Hono();
  instance.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  instance.route("/", sttConnectionsRoutes);
  return instance;
}

async function listedProviderIds(userId: string): Promise<string[]> {
  const response = await app(userId).request("/providers");
  const body = await response.json() as { providers: Array<{ id: string }> };
  return body.providers.map((provider) => provider.id);
}

afterEach(() => providerRegistry.reset());

describe("stt routes multi-tenant isolation", () => {
  test("private provider listing and resolution stay caller-scoped", async () => {
    providerRegistry.register(
      { kind: "stt", id: "alice-private" },
      { installationId: "inst-alice", installScope: "user", authenticatedSubject: ALICE },
    );
    providerRegistry.register(
      { kind: "stt", id: "system-shared" },
      { installationId: "inst-system", installScope: "system" },
    );

    expect(await listedProviderIds(ALICE)).toEqual(expect.arrayContaining(["alice-private", "system-shared"]));
    expect(await listedProviderIds(BOB)).not.toContain("alice-private");
    expect(getProvider("alice-private", BOB)).toBeNull();
    expect(getProvider("alice-private", ALICE)).not.toBeNull();
    expect(listProviders().map((provider) => provider.id)).not.toContain("alice-private");
  });
});
