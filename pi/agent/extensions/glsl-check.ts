import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const STAGES = [
  "vert",
  "tesc",
  "tese",
  "geom",
  "frag",
  "comp",
  "mesh",
  "task",
  "rgen",
  "rint",
  "rahit",
  "rchit",
  "rmiss",
  "rcall",
] as const;

// Extensions glslangValidator auto-classifies (stage comes from the extension).
const AUTO_STAGE_EXTS = new Set<string>([
  ...STAGES.map((s) => `.${s}`),
  ".hlsl",
]);

// Shader extensions collected during directory walks.
const SHADER_EXTS = new Set<string>([...AUTO_STAGE_EXTS, ".glsl"]);

// "ERROR: 0:12:5: 'foo' :  undeclared identifier"  (with --error-column; the
// middle field is always 0, line is 1-based, column is 0-based and only present
// because we pass --error-column).
const DIAG_RE =
  /^(ERROR|WARNING|INFO): \d+:(\d+)(?::(\d+))?:\s*'([^']*)'\s*:\s*(.*)$/;

const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build"]);
const MAX_FILES_PER_DIR = 200;

type Diagnostic = {
  severity: string;
  line: number;
  col?: number;
  symbol: string;
  message: string;
};

type FileResult = {
  path: string;
  status: "ok" | "errors" | "skipped" | "runner";
  diagnostics?: Diagnostic[];
  reason?: string;
};

function inferCompoundStage(baseName: string): string | undefined {
  // glslangValidator also auto-classifies compound names like main.frag.glsl.
  const m = baseName.match(
    /\.(vert|tesc|tese|geom|frag|comp|mesh|task|rgen|rint|rahit|rchit|rmiss|rcall)\.glsl$/i,
  );
  return m ? m[1].toLowerCase() : undefined;
}

function parseDiagnostics(stdout: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of stdout.split("\n")) {
    const m = DIAG_RE.exec(line);
    if (!m) continue; // skip filename echoes, summary lines, anything unexpected
    out.push({
      severity: m[1],
      line: Number(m[2]),
      col: m[3] === undefined ? undefined : Number(m[3]),
      symbol: m[4],
      message: m[5].trim(),
    });
  }
  return out;
}

function runGlslang(
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "glslangValidator",
      args,
      { signal, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === "ENOENT") {
            rejectPromise(
              new Error(
                "glslangValidator not found on PATH. Install it first (e.g. `apt install glslang-tools`, `brew install glslang`, or build from KhronosGroup/glslang).",
              ),
            );
            return;
          }
          if (e.killed) {
            rejectPromise(new Error("glslangValidator timed out after 30s"));
            return;
          }
          if (typeof e.code === "number") {
            // Non-zero exit: 2 = shader errors, 1 = usage/IO error. Not a tool failure.
            resolvePromise({ code: e.code, stdout: stdout + stderr });
            return;
          }
          rejectPromise(err); // aborts / unexpected
        } else {
          resolvePromise({ code: 0, stdout: stdout + stderr });
        }
      },
    );
  });
}

async function validateFile(
  absPath: string,
  explicitStage: string | undefined,
  signal: AbortSignal | undefined,
): Promise<FileResult> {
  const ext = extname(absPath);
  const needsStage = !AUTO_STAGE_EXTS.has(ext);
  const stage = needsStage
    ? (explicitStage ?? inferCompoundStage(basename(absPath)))
    : undefined;
  if (needsStage && !stage) {
    return {
      path: absPath,
      status: "skipped",
      reason: `no stage — plain .glsl has no stage in its extension; call again with "stage": ${STAGES.join("|")}`,
    };
  }

  const args = ["--error-column"];
  if (stage) args.push("-S", stage);
  args.push(absPath);

  const { code, stdout } = await runGlslang(args, signal);
  if (code === 0) return { path: absPath, status: "ok" };

  const diagnostics = parseDiagnostics(stdout);
  if (diagnostics.length > 0) {
    return { path: absPath, status: "errors", diagnostics };
  }
  // No recognizable diagnostics: surface the raw output (last line) so the
  // agent can see why glslangValidator bailed (unknown extension, unreadable
  // file, ...).
  const lastLine =
    stdout.trim().split("\n").slice(-1)[0] || `glslangValidator exited ${code}`;
  return { path: absPath, status: "runner", reason: lastLine };
}

async function collectShaderFiles(
  dir: string,
  out: string[],
  depth = 0,
): Promise<void> {
  if (out.length >= MAX_FILES_PER_DIR || depth > 10) return;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name))
        await collectShaderFiles(p, out, depth + 1);
    } else if (entry.isFile() && SHADER_EXTS.has(extname(entry.name))) {
      out.push(p);
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "glsl_check",
    label: "GLSL Check",
    description:
      "Validate GLSL/HLSL shader files with glslangValidator — a full semantic check (syntax, types, GLSL spec compliance), much stricter than a linter. " +
      "Accepts shader files (.glsl, .hlsl, .vert, .frag, .geom, .tesc, .tese, .comp, ...) or directories; directories are scanned recursively for shader files. " +
      "Plain .glsl files have no stage in their extension, so pass `stage` (e.g. 'frag') when checking them; for .vert/.frag/etc. the stage comes from the extension. " +
      "Returns per-file diagnostics with 1-based line and 0-based column. Use after writing or editing shader code, before assuming it compiles.",
    promptSnippet:
      "Validate shader files with glslangValidator; pass file or directory paths (stage required for plain .glsl files).",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), {
        minItems: 1,
        description:
          "Shader files or directories to validate. Relative paths resolve against the working directory.",
      }),
      stage: Type.Optional(StringEnum([...STAGES]), {
        description:
          "Shader stage for files whose extension carries no stage (plain .glsl). Ignored for .vert/.frag/.geom/etc.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();

      // 1. Expand inputs into a deduped list of shader files.
      const files: string[] = [];
      const seen = new Set<string>();
      const pathNotes: string[] = [];
      for (const raw of params.paths) {
        let p = (raw ?? "").trim();
        if (p.startsWith("@")) p = p.slice(1); // some models prepend @ to path args
        const abs = isAbsolute(p) ? p : resolve(cwd, p);
        const st = await stat(abs).catch(() => null);
        if (!st) {
          pathNotes.push(`Path not found: ${raw}`);
          continue;
        }
        if (st.isDirectory()) {
          const found: string[] = [];
          await collectShaderFiles(abs, found);
          if (found.length === 0)
            pathNotes.push(`No shader files found in: ${abs}`);
          else {
            if (found.length >= MAX_FILES_PER_DIR)
              pathNotes.push(`Capped at ${MAX_FILES_PER_DIR} files in: ${abs}`);
            files.push(...found);
          }
        } else if (st.isFile()) {
          files.push(abs);
        }
      }
      const deduped = files.filter((f) =>
        seen.has(f) ? false : (seen.add(f), true),
      );
      if (deduped.length === 0) {
        throw new Error(
          pathNotes.length ? pathNotes.join("\n") : "No shader files provided.",
        );
      }

      // 2. Validate in parallel.
      const results = await Promise.all(
        deduped.map((f) => validateFile(f, params.stage, signal)),
      );

      // 3. Render a compact, LLM-readable report.
      const failures = results.filter((r) => r.status !== "ok");
      let text: string;
      if (failures.length === 0) {
        text = `All ${results.length} shader file(s) valid.`;
      } else {
        const lines: string[] = [
          `${failures.length} of ${results.length} file(s) failed glslang validation:`,
        ];
        for (const r of failures) {
          if (r.status === "skipped") {
            lines.push(`${r.path}: SKIPPED — ${r.reason}`);
            continue;
          }
          if (r.diagnostics?.length) {
            lines.push(`${r.path}:`);
            for (const d of r.diagnostics) {
              const where = `${d.line}${d.col === undefined ? "" : `:${d.col}`}`;
              const sym = d.symbol ? `'${d.symbol}' ` : "";
              lines.push(`  ${d.severity} ${where}: ${sym}${d.message}`);
            }
          } else {
            lines.push(
              `${r.path}: ${r.reason ?? "glslangValidator exited with errors"}`,
            );
          }
        }
        if (pathNotes.length) lines.push(...pathNotes);
        text = lines.join("\n");
      }

      return {
        content: [{ type: "text" as const, text }],
        details: {
          files: results.map((r) => ({
            path: r.path,
            status: r.status,
            diagnostics: r.diagnostics ?? [],
            note: r.reason,
          })),
        },
      };
    },
  });
}
