/**
 * `code:audit:solidity` BPP handler (FN-076).
 *
 * Validates inbound `AuditInput`, loads sources via the injected
 * loader, runs the audit pipeline, sha256s the rendered Markdown,
 * and packages the result as an `AuditOutput`. All errors — including
 * schema validation failures — are converted to
 * `{ status: "failure", reason }` with a stable code so the runtime
 * routes them through `chain.failTask`.
 */

import { createHash } from "node:crypto";
import type { BppHandler, TaskResult } from "../../templates/bpp/index.js";
import {
  zAuditInput,
  type Artifact,
  type AuditInputSource,
  type AuditOutput,
  type Severity,
} from "./types.js";
import type { LoadedSources } from "./source-loader.js";
import type { RunAuditResult } from "./auditors/index.js";

export interface CreateHandlerDeps {
  readonly sourceLoader: (input: AuditInputSource) => Promise<LoadedSources>;
  readonly auditor: (
    files: LoadedSources["files"],
    opts: { severityFloor: Severity; modelId: string; solcVersion?: string },
  ) => Promise<RunAuditResult>;
  readonly modelId: string;
  /** Wall-clock seconds. Default `Math.floor(Date.now()/1000)`. */
  readonly now?: () => number;
}

export function createSolidityAuditHandler(
  deps: CreateHandlerDeps,
): BppHandler<unknown, AuditOutput> {
  return {
    async handleTask(req): Promise<TaskResult<AuditOutput>> {
      const parsed = zAuditInput.safeParse(req.input);
      if (!parsed.success) {
        return {
          status: "failure",
          reason: `input_invalid: ${flattenZodIssues(parsed.error.issues)}`,
        };
      }
      const input = parsed.data;

      let loaded: LoadedSources;
      try {
        loaded = await deps.sourceLoader(input as AuditInputSource);
      } catch (err) {
        return { status: "failure", reason: stableReason(err) };
      }

      let audited: RunAuditResult;
      try {
        const opts: {
          severityFloor: Severity;
          modelId: string;
          solcVersion?: string;
        } = {
          severityFloor: input.severityFloor,
          modelId: deps.modelId,
        };
        if (input.solcVersion !== undefined) {
          opts.solcVersion = input.solcVersion;
        }
        audited = await deps.auditor(loaded.files, opts);
      } catch (err) {
        return { status: "failure", reason: stableReason(err) };
      }

      const now = (deps.now ?? defaultNow)();
      const artifact: Artifact = {
        mimeType: "text/markdown",
        content: audited.markdown,
        sha256: sha256Hex(audited.markdown),
        producedAtSec: now,
      };
      return {
        status: "success",
        output: {
          artifact,
          report: audited.report,
          sourceBytes: loaded.sourceBytes,
        },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

function flattenZodIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
): string {
  return issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

function stableReason(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  const KNOWN = [
    "input_too_large",
    "source_too_large",
    "fetch_failed",
    "unsupported_content_type",
    "unsupported_kind",
    "audit_timeout",
  ];
  for (const k of KNOWN) {
    if (msg.startsWith(k)) return msg;
  }
  return `audit_internal_error: ${msg}`;
}
