"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { Composer } from "@/components/Composer";
import { useConversations } from "@/hooks/useConversations";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { SseParser, tryParseJson } from "@/lib/sse";
import type { ChatEvent, Role } from "@/lib/types";

export default function Home() {
  const {
    conversations,
    active,
    activeId,
    settings,
    createConversation,
    deleteConversation,
    renameConversation,
    appendMessage,
    updateMessage,
    updateSettings,
    setActiveId,
  } = useConversations();

  const [draft, setDraft] = useState("");
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [liveUserTranscript, setLiveUserTranscript] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const recorder = useVoiceRecorder();
  const speech = useSpeechRecognition();
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    speech.setCallbacks({
      onPartial: (text) => setLiveUserTranscript(text),
      onFinal: (text) => setLiveUserTranscript(text),
    });
  }, [speech]);

  const conversationTurns = useCallback(() => {
    if (!active) return [];
    return active.messages
      .filter((message) => message.status !== "error")
      .slice(-20)
      .map((message) => ({ role: message.role, text: message.text }));
  }, [active]);

  const sendTurn = useCallback(
    async (input: { text?: string; audio?: { data: string; format: "wav" } }) => {
      if (busyRef.current) return;
      const conversation = active ?? createConversation();
      const conversationId = conversation.id;
      const hasAudio = Boolean(input.audio);
      const hasText = Boolean(input.text && input.text.trim());
      const source = hasAudio && hasText ? "mixed" : hasAudio ? "voice" : "typed";
      const initialUserText = hasText ? input.text!.trim() : liveUserTranscript || "🎤 voice message";

      const userMessage = appendMessage(conversationId, "user" as Role, initialUserText, source);
      const assistantMessage = appendMessage(conversationId, "assistant" as Role, "", "typed");
      setBusy(true);
      busyRef.current = true;
      setBanner(null);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: settings.model,
            turns: conversationTurns(),
            text: hasText ? input.text!.trim() : undefined,
            audio: input.audio,
          }),
        });

        if (!response.ok || !response.body) {
          const detail = await response
            .json()
            .then((parsed: { error?: string }) => parsed.error ?? response.statusText)
            .catch(() => `${response.status} ${response.statusText}`);
          updateMessage(conversationId, assistantMessage.id, {
            status: "error",
            error: detail,
          });
          return;
        }

        const parser = new SseParser();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let assistantText = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
            const parsed = tryParseJson(event.data) as ChatEvent | null;
            if (!parsed || typeof parsed.type !== "string") continue;
            if (parsed.type === "delta" && typeof parsed.text === "string") {
              assistantText += parsed.text;
              updateMessage(conversationId, assistantMessage.id, { text: assistantText });
            } else if (parsed.type === "user_transcript" && typeof parsed.text === "string") {
              if (source !== "typed") {
                updateMessage(conversationId, userMessage.id, { text: parsed.text });
              }
            } else if (parsed.type === "turn_done") {
              updateMessage(conversationId, assistantMessage.id, { status: "done" });
            } else if (parsed.type === "error" && typeof parsed.message === "string") {
              updateMessage(conversationId, assistantMessage.id, {
                status: "error",
                error: parsed.message,
              });
            }
          }
        }
        updateMessage(conversationId, assistantMessage.id, { status: "done" });
      } catch (error) {
        const message =
          error instanceof DOMException && error.name === "AbortError"
            ? "Stopped."
            : (error as Error).message;
        updateMessage(conversationId, assistantMessage.id, { status: "error", error: message });
      } finally {
        setBusy(false);
        busyRef.current = false;
        abortRef.current = null;
      }
    },
    [active, appendMessage, conversationTurns, createConversation, liveUserTranscript, settings.model, updateMessage],
  );

  const onMicDown = useCallback(async () => {
    if (busyRef.current) return;
    setLiveUserTranscript("");
    setBusy(true);
    busyRef.current = true;
    try {
      await recorder.start({ onLevel: setLevel });
      speech.start();
    } catch (error) {
      setBusy(false);
      busyRef.current = false;
      setBanner((error as Error).message);
    }
  }, [recorder, speech]);

  const onMicUp = useCallback(async () => {
    if (!recorder.recording) return;
    setLevel(0);
    const transcript = speech.stop();
    try {
      const recording = await recorder.stop();
      setBusy(false);
      busyRef.current = false;
      setLiveUserTranscript("");
      if (!recording) {
        setBanner("No audio captured; try again.");
        return;
      }
      if (recording.seconds < 0.4) {
        setBanner("Recording was too short; hold the mic while you speak.");
        return;
      }
      if (transcript) setLiveUserTranscript("");
      await sendTurn({ audio: { data: recording.wavBase64, format: "wav" } });
    } catch (error) {
      setBusy(false);
      busyRef.current = false;
      setBanner((error as Error).message);
    }
  }, [recorder, sendTurn, speech]);

  const onSendTyped = useCallback(() => {
    const text = draft.trim();
    if (!text || busyRef.current) return;
    setDraft("");
    void sendTurn({ text });
  }, [draft, sendTurn]);

  const stopEverything = useCallback(() => {
    abortRef.current?.abort();
    if (recorder.recording) void recorder.stop();
    setBusy(false);
    busyRef.current = false;
  }, [recorder]);

  useEffect(() => {
    const onUnload = () => {
      abortRef.current?.abort();
      if (recorder.recording) void recorder.stop();
    };
    window.addEventListener("beforeunload", onUnload);
    // Mount-only: do not abort in the cleanup — this component re-renders
    // constantly while streaming, and an effect keyed on a fresh `recorder`
    // object every render would abort every in-flight stream.
    return () => {
      window.removeEventListener("beforeunload", onUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <button
          type="button"
          className="icon-button menu-button"
          title="Conversations"
          onClick={() => setSidebarOpen((open) => !open)}
        >
          ☰
        </button>
        <span className="topbar-title">voice-session</span>
        <span className="topbar-model">{settings.model}</span>
        {busy ? (
          <button type="button" className="button stop" onClick={stopEverything}>
            Stop
          </button>
        ) : (
          <span className={`dot ${banner ? "red" : "green"}`} title={banner ?? "Ready"} />
        )}
      </header>
      {banner ? <div className="banner">{banner}</div> : null}
      <div className="layout">
        <div className={`sidebar-column${sidebarOpen ? " open" : ""}`}>
          <Sidebar
            conversations={conversations}
            activeId={activeId}
            model={settings.model}
            onSelect={(id) => {
              setActiveId(id);
              setSidebarOpen(false);
            }}
            onNew={() => {
              createConversation();
              setSidebarOpen(false);
            }}
            onDelete={deleteConversation}
            onRename={renameConversation}
            onModelChange={(model) => updateSettings({ model })}
          />
        </div>
        <main className="main">
          <TranscriptPanel
            conversation={active}
            liveUserTranscript={liveUserTranscript}
            level={level}
            recording={recorder.recording}
          />
          <Composer
            busy={busy}
            recording={recorder.recording}
            micError={recorder.error}
            draft={draft}
            onDraftChange={setDraft}
            onMicDown={() => void onMicDown()}
            onMicUp={() => void onMicUp()}
            onSendTyped={onSendTyped}
          />
        </main>
      </div>
    </div>
  );
}