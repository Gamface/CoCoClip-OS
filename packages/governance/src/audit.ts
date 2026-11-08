import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

/** Canonical JSON (sorted keys) so the hash is stable across runtimes. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

function hashOf(e: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(canonical(e)).digest("hex");
}

/**
 * Append-only, hash-chained audit log (JSONL). Each entry commits to the previous
 * one, so editing or deleting any past line breaks `verify()`. Complements Paperclip's
 * activity log with tool-level detail (args, firewall findings, approvals).
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private listeners = new Set<(e: AuditEntry) => void>();

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      this.entries = readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditEntry);
    } else if (file) {
      mkdirSync(dirname(file), { recursive: true });
    }
  }

  append(type: string, actor: string, data: unknown): AuditEntry {
    const prev = this.entries.at(-1);
    const base = { seq: (prev?.seq ?? 0) + 1, ts: new Date().toISOString(), type, actor, data, prevHash: prev?.hash ?? GENESIS };
    const entry: AuditEntry = { ...base, hash: hashOf(base) };
    this.entries.push(entry);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    for (const l of this.listeners) l(entry);
    return entry;
  }

  onAppend(fn: (e: AuditEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  tail(n = 100): AuditEntry[] {
    return this.entries.slice(-n);
  }

  verify(): { ok: true; length: number } | { ok: false; brokenAt: number } {
    let prev = GENESIS;
    for (const e of this.entries) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || hashOf(rest) !== hash) return { ok: false, brokenAt: e.seq };
      prev = hash;
    }
    return { ok: true, length: this.entries.length };
  }
}
