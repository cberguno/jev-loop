"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation, Message, Role } from "@/lib/types";

const STORAGE_KEY = "voice-session.conversations.v1";
const SETTINGS_KEY = "voice-session.settings.v1";

export interface Settings {
  model: string;
}

const DEFAULT_SETTINGS: Settings = { model: "openai/gpt-audio" };

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadConversations(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Conversation[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : null;
    return {
      model:
        typeof parsed?.model === "string" && parsed.model ? parsed.model : DEFAULT_SETTINGS.model,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function titleFrom(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "New chat";
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
}

/**
 * localStorage-backed conversation history.
 *
 * All mutations run against `conversationsRef` (kept in sync with React
 * state), so two mutations in one event handler compose correctly instead of
 * clobbering each other through a stale closure.
 */
export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const conversationsRef = useRef<Conversation[]>([]);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const loaded = loadConversations();
    conversationsRef.current = loaded;
    setConversations(loaded);
    const loadedSettings = loadSettings();
    settingsRef.current = loadedSettings;
    setSettings(loadedSettings);
    setHydrated(true);
    if (loaded.length > 0) {
      setActiveId(loaded[0]?.id ?? null);
    }
  }, []);

  const commit = useCallback((mutate: (current: Conversation[]) => Conversation[]) => {
    const next = mutate(conversationsRef.current);
    conversationsRef.current = next;
    setConversations(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // storage full or blocked; history just won't persist
      }
    }
    return next;
  }, []);

  const createConversation = useCallback((): Conversation => {
    const conversation: Conversation = {
      id: newId(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: settingsRef.current.model,
      messages: [],
    };
    commit((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    return conversation;
  }, [commit]);

  const deleteConversation = useCallback(
    (id: string) => {
      commit((current) => current.filter((conversation) => conversation.id !== id));
      setActiveId((current) => (current === id ? conversationsRef.current[0]?.id ?? null : current));
    },
    [commit],
  );

  const renameConversation = useCallback(
    (id: string, title: string) => {
      commit((current) =>
        current.map((conversation) =>
          conversation.id === id ? { ...conversation, title: title || conversation.title } : conversation,
        ),
      );
    },
    [commit],
  );

  const appendMessage = useCallback(
    (conversationId: string, role: Role, text: string, source: Message["source"]): Message => {
      const message: Message = {
        id: newId(),
        role,
        text,
        status: role === "assistant" ? "streaming" : "done",
        createdAt: Date.now(),
        source,
      };
      commit((current) =>
        current.map((conversation) => {
          if (conversation.id !== conversationId) return conversation;
          return {
            ...conversation,
            title:
              conversation.messages.length === 0 && role === "user"
                ? titleFrom(text)
                : conversation.title,
            updatedAt: Date.now(),
            messages: [...conversation.messages, message],
          };
        }),
      );
      return message;
    },
    [commit],
  );

  const updateMessage = useCallback(
    (conversationId: string, messageId: string, patch: Partial<Pick<Message, "text" | "status" | "error">>) => {
      commit((current) =>
        current.map((conversation) => {
          if (conversation.id !== conversationId) return conversation;
          return {
            ...conversation,
            updatedAt: Date.now(),
            messages: conversation.messages.map((message) =>
              message.id === messageId ? { ...message, ...patch } : message,
            ),
          };
        }),
      );
    },
    [commit],
  );

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
    }
  }, []);

  const active =
    conversations.find((conversation) => conversation.id === activeId) ??
    (activeId === null ? null : conversationsRef.current.find((c) => c.id === activeId) ?? null);

  return {
    conversations,
    active,
    activeId,
    settings,
    hydrated,
    setActiveId,
    createConversation,
    deleteConversation,
    renameConversation,
    appendMessage,
    updateMessage,
    updateSettings,
  };
}