import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWindowsMsvc, windowsMsvcCommand } from "./windows-msvc";

const installation = "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools";
const vcvarsall = `${installation}\\VC\\Auxiliary\\Build\\vcvarsall.bat`;

describe("resolveWindowsMsvc", () => {
  test("uses a configured developer environment without invoking Visual Studio setup", async () => {
    const commands: string[][] = [];
    const result = await resolveWindowsMsvc({
      arch: "x64",
      env: { LIB: "C:\\SDK\\lib", INCLUDE: "C:\\SDK\\include" },
      probe: async (command) => {
        commands.push(command);
        return { ok: true, out: `${installation}\\VC\\Tools\\MSVC\\bin\\HostX64\\x64\\link.exe` };
      },
    });

    expect(result.ready).toBe(true);
    expect(result.vcvarsall).toBeUndefined();
    expect(commands).toEqual([["where.exe", "link.exe"]]);
  });

  test("finds the C++ workload and validates its linker in an ordinary shell", async () => {
    const commands: string[][] = [];
    const env = { "ProgramFiles(x86)": "C:\\Program Files (x86)", PATH: "C:\\Windows\\System32" };
    const result = await resolveWindowsMsvc({
      arch: "x64",
      env,
      exists: (path) => path.endsWith("vswhere.exe") || path === vcvarsall,
      probe: async (command) => {
        commands.push(command);
        if (command[0]?.endsWith("vswhere.exe")) return { ok: true, out: installation };
        if (command[0] === "cmd.exe") return { ok: true, out: `${installation}\\VC\\Tools\\MSVC\\bin\\HostX64\\x64\\link.exe` };
        return { ok: false, out: "" };
      },
    });

    expect(result).toEqual({
      ready: true,
      detail: `MSVC linker found at ${installation}; build will load its developer environment`,
      vcvarsall,
      architecture: "amd64",
    });
    expect(commands[1]).toContain("Microsoft.VisualStudio.Component.VC.Tools.x86.x64");
    expect(commands[2]?.at(-1)).toContain(`call "${vcvarsall}" amd64 >nul && "where.exe" "link.exe"`);
  });

  test("distinguishes missing C++ components from Build Tools being installed", async () => {
    const result = await resolveWindowsMsvc({
      arch: "x64",
      env: {},
      exists: () => true,
      probe: async () => ({ ok: true, out: "" }),
    });

    expect(result.ready).toBe(false);
    expect(result.detail).toContain("Microsoft.VisualStudio.Component.VC.Tools.x86.x64");
    expect(result.detail).toContain("Desktop development with C++");
  });

  test("reports an unconfigured linker before attempting a lengthy build", async () => {
    const result = await resolveWindowsMsvc({
      arch: "x64",
      env: {},
      exists: () => false,
      probe: async () => ({ ok: false, out: "" }),
    });

    expect(result.ready).toBe(false);
    expect(result.detail).toContain("link.exe is not configured");
  });

  test("rejects a toolset whose developer environment cannot find the linker", async () => {
    const commands: string[][] = [];
    const result = await resolveWindowsMsvc({
      arch: "arm64",
      env: {},
      exists: () => true,
      probe: async (command) => {
        commands.push(command);
        return command[0]?.endsWith("vswhere.exe")
          ? { ok: true, out: installation }
          : { ok: false, out: "" };
      },
    });

    expect(result.ready).toBe(false);
    expect(result.detail).toContain("amd64_arm64");
    expect(commands[1]).toContain("Microsoft.VisualStudio.Component.VC.Tools.ARM64");
  });
});

test("starts the Tauri build inside the validated MSVC environment", () => {
  expect(windowsMsvcCommand(
    ["bun", "run", "tauri:finalized", "build", "--bundles", "nsis"],
    vcvarsall,
    "amd64",
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  )).toEqual([
    "C:\\Windows\\System32\\cmd.exe",
    "/d", "/s", "/c",
    `call "${vcvarsall}" amd64 >nul && "bun" "run" "tauri:finalized" "build" "--bundles" "nsis"`,
  ]);
});

test("executes a batch-configured child process on Windows", async () => {
  if (process.platform !== "win32") return;

  const directory = mkdtempSync(join(tmpdir(), "lumiverse-msvc-"));
  const setup = join(directory, "setup with spaces.bat");
  writeFileSync(setup, '@echo off\r\nset "LUMIVERSE_MSVC_TEST=ready"\r\n');
  try {
    const child = Bun.spawn({
      cmd: windowsMsvcCommand(
        [process.execPath, "-e", "console.log(process.env.LUMIVERSE_MSVC_TEST)"],
        setup,
        "amd64",
        process.env,
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(out.trim()).toBe("ready");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
