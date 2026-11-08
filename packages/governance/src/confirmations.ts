import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { canonical } from "./audit.js";

/**
 * Human-confirmation tokens for the chat operator.
 *
 * The CopilotKit operator agent may *propose* side-effecting actions (create a task,
 * wake an agent), but the server tool refuses to run without a token that only the
 * frontend's human-in-the-loop card can mint after a click. The token is bound to the
 * exact action + arguments, expires, and is single-use - so a prompt-injected model
 * cannot skip the human, reuse an old approval, or swap arguments after approval.
 */
export class ConfirmationTokens {
  private readonly used = new Map<string, number>();

  constructor(private readonly secret: string, private readonly ttlSec = 300) {
    if (secret.length < 16) throw new Error("confirmation secret must be at least 16 chars");
  }

  mint(action: string, args: unknown): string {
    const nonce = randomUUID();
    const exp = Math.floor(Date.now() / 1000) + this.ttlSec;
    const sig = this.sign(action, args, nonce, exp);
    return Buffer.from(JSON.stringify({ nonce, exp, sig })).toString("base64url");
  }

  verify(token: string | undefined, action: string, args: unknown): { ok: true } | { ok: false; reason: string } {
    if (!token) return { ok: false, reason: "missing confirmation token - ask the human via confirm_action first" };
    let parsed: { nonce: string; exp: number; sig: string };
    try {
      parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    } catch {
      return { ok: false, reason: "malformed token" };
    }
    const now = Math.floor(Date.now() / 1000);
    if (parsed.exp < now) return { ok: false, reason: "token expired" };
    if (this.used.has(parsed.nonce)) return { ok: false, reason: "token already used" };
    const expected = Buffer.from(this.sign(action, args, parsed.nonce, parsed.exp));
    const got = Buffer.from(String(parsed.sig));
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      return { ok: false, reason: "token does not match this action/arguments" };
    }
    this.used.set(parsed.nonce, parsed.exp);
    for (const [n, exp] of this.used) if (exp < now) this.used.delete(n);
    return { ok: true };
  }

  private sign(action: string, args: unknown, nonce: string, exp: number) {
    return createHmac("sha256", this.secret).update(`${action}\n${canonical(args)}\n${nonce}\n${exp}`).digest("hex");
  }
}
