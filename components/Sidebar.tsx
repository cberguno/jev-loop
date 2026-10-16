"use client";

import { useEffect, useState } from "react";
import { MODEL_SUGGESTIONS, type Conversation } from "@/lib/types";

export interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  model: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onModelChange: (model: string) => void;
}

function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function Sidebar({
  conversations,
  activeId,
  model,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onModelChange,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [customModel, setCustomModel] = useState(
    MODEL_SUGGESTIONS.some((suggestion) => suggestion.id === model) ? "" : model,
  );

  // Keep the custom-field in sync when the model changes elsewhere.
  useEffect(() => {
    setCustomModel(MODEL_SUGGESTIONS.some((suggestion) => suggestion.id === model) ? "" : model);
  }, [model]);

  const commitRename = (id: string) => {
    onRename(id, draftTitle.trim());
    setEditingId(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">voice-session</span>
        <button type="button" className="button new-chat" onClick={onNew}>
          + New chat
        </button>
      </div>
      <ul className="conversation-list">
        {conversations.map((conversation) => (
          <li
            key={conversation.id}
            className={`conversation-item${conversation.id === activeId ? " active" : ""}`}
          >
            {editingId === conversation.id ? (
              <input
                autoFocus
                className="rename-input"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={() => commitRename(conversation.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename(conversation.id);
                  if (event.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <>
                <button
                  type="button"
                  className="conversation-open"
                  onClick={() => onSelect(conversation.id)}
                  onDoubleClick={() => {
                    setEditingId(conversation.id);
                    setDraftTitle(conversation.title);
                  }}
                  title={conversation.title}
                >
                  <span className="conversation-title">{conversation.title}</span>
                  <span className="conversation-meta">
                    {conversation.messages.length} msgs · {relativeTime(conversation.updatedAt)}
                  </span>
                </button>
                <div className="conversation-actions">
                  <button
                    type="button"
                    className="icon-button"
                    title="Rename"
                    onClick={() => {
                      setEditingId(conversation.id);
                      setDraftTitle(conversation.title);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title="Delete"
                    onClick={() => onDelete(conversation.id)}
                  >
                    ✕
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
        {conversations.length === 0 ? (
          <li className="empty-note">No conversations yet.</li>
        ) : null}
      </ul>
      <div className="sidebar-footer">
        <label className="field-label" htmlFor="model-select">
          Model
        </label>
        <select
          id="model-select"
          value={MODEL_SUGGESTIONS.some((suggestion) => suggestion.id === model) ? model : "__custom"}
          onChange={(event) => {
            if (event.target.value === "__custom") return;
            onModelChange(event.target.value);
          }}
        >
          {MODEL_SUGGESTIONS.map((suggestion) => (
            <option key={suggestion.id} value={suggestion.id}>
              {suggestion.label}
            </option>
          ))}
          <option value="__custom">Custom…</option>
        </select>
        <input
          className="model-custom"
          placeholder="or type any OpenRouter model id"
          value={customModel}
          onChange={(event) => setCustomModel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && customModel.trim()) onModelChange(customModel.trim());
          }}
          onBlur={() => {
            if (customModel.trim()) onModelChange(customModel.trim());
          }}
        />
        <p className="hint">Audio-capable model ids work best (e.g. openai/gpt-audio).</p>
      </div>
    </aside>
  );
}