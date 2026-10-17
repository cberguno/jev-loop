"use client";

import { useEffect, useRef, useState } from "react";
import type { Conversation, Message } from "@/lib/types";

export interface TranscriptPanelProps {
  conversation: Conversation | null;
  /** Live interim transcript of the user while the mic is recording. */
  liveUserTranscript: string;
  level: number;
  recording: boolean;
  /** A spoken reply is currently being played back. */
  speaking: boolean;
}

function Bubble({ message }: { message: Message }) {
  const mine = message.role === "user";
  return (
    <div className={`bubble-row ${mine ? "mine" : "theirs"}`}>
      <div className={`bubble ${mine ? "mine" : "theirs"}${message.status === "error" ? " error" : ""}`}>
        <div className="bubble-role">
          {mine ? (message.source === "voice" ? "🎤 You (voice)" : "You") : "🔊 Model"}
        </div>
        <div className="bubble-text">
          {message.text}
          {message.status === "streaming" ? <span className="cursor" aria-hidden /> : null}
        </div>
        {message.error ? <div className="bubble-error">{message.error}</div> : null}
      </div>
    </div>
  );
}

export function TranscriptPanel({
  conversation,
  liveUserTranscript,
  level,
  recording,
  speaking,
}: TranscriptPanelProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [conversation, autoScroll]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  return (
    <div className="transcript-panel">
      {speaking ? (
        <div className="speaker-indicator" role="status">
          🔊 Model is speaking
        </div>
      ) : null}
      <div className="transcript-scroll" ref={scrollerRef} onScroll={onScroll}>
        {conversation && conversation.messages.length > 0 ? (
          conversation.messages.map((message) => <Bubble key={message.id} message={message} />)
        ) : (
          <div className="welcome">
            <h2>Text &amp; voice chat</h2>
            <p>
              Hold the mic button and speak: your speech is sent to an OpenRouter audio-capable
              model and both sides appear here as live transcript text. Or just type below.
            </p>
          </div>
        )}
        {recording || liveUserTranscript ? (
          <div className="bubble-row mine">
            <div className="bubble mine live">
              <div className="bubble-role">
                {recording ? "🎤 You — listening" : "🎤 You"}
              </div>
              {liveUserTranscript ? (
                <div className="bubble-text interim">{liveUserTranscript}</div>
              ) : (
                <div className="bubble-text interim muted">Listening…</div>
              )}
              <div className="level-meter" aria-hidden>
                {Array.from({ length: 14 }).map((_, index) => (
                  <span
                    key={index}
                    className={`level-bar${level * 14 > index ? " on" : ""}`}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}