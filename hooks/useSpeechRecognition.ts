"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface SpeechCallbacks {
  /** Live partial guess of what the user is saying. */
  onPartial?: (text: string) => void;
  /** A finalized phrase (sentence-level). */
  onFinal?: (text: string) => void;
}

/**
 * Live in-browser transcription of the user's speech while recording, so the
 * user sees their own words on screen before the model replies. Optional:
 * when the browser lacks the Web Speech API the server-side
 * `input_audio_transcription` path alone still shows the user's speech.
 */
export function useSpeechRecognition() {
  const [supported] = useState(() => {
    if (typeof window === "undefined") return false;
    return Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);
  });
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const callbacksRef = useRef<SpeechCallbacks>({});
  const finalRef = useRef("");
  const partialRef = useRef("");

  const setCallbacks = useCallback((next: SpeechCallbacks) => {
    callbacksRef.current = next;
  }, []);

  const start = useCallback(() => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return;
    const recognition = new Ctor();
    recognitionRef.current = recognition;
    finalRef.current = "";
    partialRef.current = "";
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalRef.current = `${finalRef.current} ${transcript}`.trim();
          partialRef.current = "";
          callbacksRef.current.onFinal?.(finalRef.current);
        } else {
          interim += transcript;
        }
      }
      partialRef.current = interim;
      const live = [finalRef.current, interim].filter(Boolean).join(" ");
      callbacksRef.current.onPartial?.(live);
    };
    recognition.onend = () => {
      // Chrome stops on silence; restart while the mic session is live.
      if (recognitionRef.current === recognition) {
        try {
          recognition.start();
        } catch {
          recognitionRef.current = null;
        }
      }
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
    };
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return finalRef.current;
    try {
      recognition.onend = null;
      recognition.stop();
    } catch {
      // already stopped
    }
    return finalRef.current;
  }, []);

  useEffect(() => {
    const recognition = recognitionRef.current;
    return () => {
      try {
        recognition?.abort();
      } catch {
        // noop
      }
    };
  }, []);

  return { supported, start, stop, setCallbacks };
}