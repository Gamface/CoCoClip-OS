"use client";

import { useState } from "react";
import { setToken } from "@/api";
import { useAuth } from "@/useAuth";

/**
 * Inline operator-token sign-in. Shown automatically when the backend answers 401
 * (OPERATOR_TOKEN is set), or when the operator opens it from the header.
 */
export function TokenGate({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { token, required, rejected } = useAuth();
  const [value, setValue] = useState("");
  if (!required && !open) return null;

  return (
    <form
      className="token-gate"
      onSubmit={(e) => {
        e.preventDefault();
        setToken(value);
        setValue("");
        onClose();
      }}
    >
      <div className="token-gate-text">
        <strong>{required ? "Operator token required" : "Operator token"}</strong>
        <span className="muted small">
          {rejected
            ? "That token was rejected. Check OPERATOR_TOKEN in .env and paste it again."
            : required
              ? "This command center is protected. Paste the OPERATOR_TOKEN value from .env to use the chat and panels."
              : "Saved in this browser only. Leave blank and save to sign out."}
        </span>
      </div>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label="Operator token"
        placeholder={token ? "•••••••• (saved)" : "Paste token"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <button type="submit" className="approve" disabled={required && !value.trim()}>
        {value.trim() || required ? "Save" : "Sign out"}
      </button>
      {!required && (
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      )}
    </form>
  );
}
