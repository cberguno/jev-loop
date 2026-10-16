"use client";

import { useRef, useState } from "react";

export interface ComposerProps {
  busy: boolean;
  recording: boolean;
  micError: string | null;
  draft: string;
  onDraftChange: (text: string) => void;
  onMicDown: () => void;
  onMicUp: () => void;
  onSendTyped: () => void;
}

/**
 * Input row: push-to-talk mic button plus a text box. Typed text is sent
 * alone, or together with the recording when the mic was used.
 */
export function Composer({
  busy,
  recording,
  micError,
  draft,
  onDraftChange,
  onMicDown,
  onMicUp,
  onSendTyped,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="composer">
      {micError ? <div className="composer-error">{micError}</div> : null}
      <div className="composer-row">
        <button
          type="button"
          className={`mic-button${recording ? " recording" : ""}`}
          disabled={busy && !recording}
          title={recording ? "Release to send" : "Hold to record"}
          onPointerDown={(event) => {
            event.preventDefault();
            if (!busy || recording) onMicDown();
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            if (recording) onMicUp();
          }}
          onPointerLeave={() => {
            if (recording) onMicUp();
          }}
        >
          {recording ? "■" : "🎤"}
        </button>
        <textarea
          ref={textareaRef}
          value={draft}
          placeholder={
            recording
              ? "Recording… release the mic to send (typed text is sent alongside)"
              : "Type a message, or hold 🎤 to speak"
          }
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!busy) onSendTyped();
            }
          }}
          rows={2}
        />
        <button
          type="button"
          className="send-button"
          disabled={busy || recording || draft.trim().length === 0}
          onClick={onSendTyped}
        >
          Send
        </button>
      </div>
      <p className="composer-hint">
        Enter sends text · Shift+Enter adds a newline · hold the mic and speak to send voice
        (with any typed text attached).
      </p>
    </div>
  );
}