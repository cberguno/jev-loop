"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { base64ToBytes, pcm16ToFloat32 } from "@/lib/pcm";

/**
 * Plays streamed spoken-reply chunks (pcm16) through Web Audio, scheduling
 * each buffer back-to-back so the reply plays gapless as it streams in.
 */
export function useSpokenReplies() {
  const [speaking, setSpeaking] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextTimeRef = useRef<number>(0);

  const supported =
    typeof window !== "undefined" &&
    Boolean((window as { AudioContext?: unknown }).AudioContext);

  const push = useCallback(
    (base64: string, sampleRate: number) => {
      if (
        typeof window === "undefined" ||
        !sampleRate ||
        !base64 ||
        (window as { AudioContext?: unknown }).AudioContext === undefined
      ) {
        return;
      }
      const Ctor = window.AudioContext;
      if (!Ctor) return;
      let ctx = ctxRef.current;
      if (!ctx || ctx.state === "closed") {
        ctx = new Ctor();
        ctxRef.current = ctx;
        nextTimeRef.current = 0;
      }
      void ctx.resume().catch(() => undefined);
      const samples = pcm16ToFloat32(base64ToBytes(base64));
      if (samples.length === 0) return;
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(new Float32Array(samples), 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const when = Math.max(ctx.currentTime + 0.03, nextTimeRef.current);
      source.start(when);
      nextTimeRef.current = when + buffer.duration;
      sourcesRef.current.push(source);
      setSpeaking(true);
      source.onended = () => {
        sourcesRef.current = sourcesRef.current.filter((item) => item !== source);
        if (sourcesRef.current.length === 0) {
          setSpeaking(false);
        }
      };
    },
    [],
  );

  const stopAll = useCallback(() => {
    for (const source of sourcesRef.current) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // already stopped
      }
    }
    sourcesRef.current = [];
    nextTimeRef.current = 0;
    setSpeaking(false);
  }, []);

  useEffect(() => {
    const cleanup = () => {
      for (const source of sourcesRef.current) {
        try {
          source.stop();
        } catch {
          // noop
        }
      }
    };
    return cleanup;
  }, []);

  return { speaking, push, stopAll, supported };
}