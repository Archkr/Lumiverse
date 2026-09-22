import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { meetsVersion, MIN_BUN_VERSION } from "../scripts/desktop-toolchain";

const root = join(import.meta.dir, "..");

async function read(path: string): Promise<string> {
  return Bun.file(join(root, path)).text();
}

describe("Bun runtime version policy", () => {
  test("keeps runtime, types, Docker, desktop CI, and launchers on 1.4.2", async () => {
    const [rootPackage, frontendPackage, dockerfile, desktopBuild, desktopRelease, unixLauncher, windowsLauncher, backendRuntime, desktopRunner] =
      await Promise.all([
        Bun.file(join(root, "package.json")).json(),
        Bun.file(join(root, "frontend", "package.json")).json(),
        read("Dockerfile"),
        read(".github/workflows/desktop-build.yml"),
        read(".github/workflows/desktop-release.yml"),
        read("start.sh"),
        read("start.ps1"),
        read("src/index.ts"),
        read("scripts/runner.ts"),
      ]);

    expect(rootPackage.packageManager).toBe("bun@1.4.2");
    expect(rootPackage.engines?.bun).toBe(">=1.4.2");
    expect(rootPackage.devDependencies?.["bun-types"]).toBe("^1.4.2");
    expect(frontendPackage.devDependencies?.["bun-types"]).toBe("^1.4.2");
    expect(MIN_BUN_VERSION).toBe("1.4.2");

    const pinnedImage =
      "oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61";
    expect(dockerfile.match(new RegExp(pinnedImage, "g"))).toHaveLength(3);
    expect(desktopBuild).toContain("bun-version: 1.4.2");
    expect(desktopRelease).toContain("bun-version: 1.4.2");
    expect(unixLauncher).toContain('MINIMUM_BUN_VERSION="1.4.2"');
    expect(windowsLauncher).toContain('$MinimumBunVersion = [version]"1.4.2"');
    expect(backendRuntime).toContain("const _bunMinimum: readonly [number, number, number] = [1, 4, 2]");
    expect(desktopRunner).toContain("const minimum: readonly [number, number, number] = [1, 4, 2]");
  });

  test("rejects 1.4.1 and keeps the PowerShell upgrade gate before mode dispatch", async () => {
    expect(meetsVersion("1.4.1", MIN_BUN_VERSION)).toBe(false);
    expect(meetsVersion("1.4.2", MIN_BUN_VERSION)).toBe(true);

    const launcher = await read("start.ps1");
    const gateStart = launcher.indexOf("function Ensure-MinimumBunVersion {");
    const gateEnd = launcher.indexOf("\n# ─── First-run setup wizard", gateStart);
    const gate = launcher.slice(gateStart, gateEnd);

    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);
    expect(gate.match(/Get-BunSemanticVersion/g)).toHaveLength(2);
    expect(gate).toContain('Invoke-BunUpgrade "stable"');
    expect(gate).toContain("exit 1");
    expect(launcher).toContain("Ensure-Bun\nUpdate-BunChannel\nEnsure-MinimumBunVersion\n");
  });

  test("upgrades native Termux through bun-termux before enforcing the floor", async () => {
    const launcher = await read("start.sh");
    const upgradeStart = launcher.indexOf("upgrade_bun_channel() {");
    const upgradeEnd = launcher.indexOf("\nupgrade_bun_if_requested()", upgradeStart);
    const upgradeFunction = launcher.slice(upgradeStart, upgradeEnd);
    const standardPath = upgradeFunction.indexOf("# ── Standard path");
    const nativeTermuxPath = upgradeFunction.slice(0, standardPath);

    expect(upgradeStart).toBeGreaterThanOrEqual(0);
    expect(upgradeEnd).toBeGreaterThan(upgradeStart);
    expect(standardPath).toBeGreaterThanOrEqual(0);
    expect(nativeTermuxPath).toContain('if [[ "$IS_TERMUX" == true ]]');
    expect(nativeTermuxPath).toContain("upgrade_bun_termux");
    expect(nativeTermuxPath).toContain("_resolve_bun");
    expect(nativeTermuxPath).toContain("verify_termux_bun_install_path");
    expect(nativeTermuxPath).not.toContain("_bun upgrade");
    expect(launcher).toContain('bash "$manager" update all --source "$repo"');
    expect(launcher).toContain(
      "ensure_bun\nupgrade_bun_if_requested\nensure_minimum_bun_version\nexport_termux_bun_env",
    );
  });
});
