"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWavFromChannels } from "@/lib/wav";

export interface VoiceRecording {
  /** Base64 16-bit PCM WAV of everything captured this turn. */
  wavBase64: string;
  byteLength: number;
  seconds: number;
}

interface StartOptions {
  onLevel?: (level: number) => void;
}

/**
 * Push-to-talk microphone capture. Records with MediaRecorder while the mic
 * is live, keeps a live level meter running, and on stop decodes the full
 * recording to mono 16-bit PCM WAV (the format audio-capable models accept).
 */
export function useVoiceRecorder() {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const levelRef = useRef<StartOptions["onLevel"]>(undefined);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    mediaRef.current?.getTracks().forEach((track) => track.stop());
    mediaRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    setRecording(false);
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(
    async (options?: StartOptions): Promise<void> => {
      setError(null);
      levelRef.current = options?.onLevel;
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser cannot capture microphone audio.");
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        mediaRef.current = stream;
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
            ? "audio/webm"
            : "";
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        chunksRef.current = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.start(250); // timeslice: chunks stream in while speaking
        recorderRef.current = recorder;
        startedAtRef.current = performance.now();
        setRecording(true);

        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) {
            peak = Math.max(peak, Math.abs((buf[i] ?? 128) - 128) / 128);
          }
          levelRef.current?.(Math.min(1, peak * 2));
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (cause) {
        teardown();
        const message =
          cause instanceof DOMException && cause.name === "NotAllowedError"
            ? "Microphone permission was denied."
            : (cause as Error).message;
        setError(message);
        throw new Error(message);
      }
    },
    [teardown],
  );

  /** Stop the mic and resolve the turn's audio as a WAV. */
  const stop = useCallback(async (): Promise<VoiceRecording | null> => {
    levelRef.current?.(0);
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      teardown();
      return null;
    }
    const seconds = (performance.now() - startedAtRef.current) / 1000;
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }));
      recorder.stop();
    });
    teardown();
    if (blob.size === 0) return null;
    const arrayBuffer = await blob.arrayBuffer();
    const ctx = audioCtxRef.current ?? new AudioContext();
    const decoded = await ctx.decodeAudioData(arrayBuffer).catch(() => null);
    if (!decoded) {
      throw new Error("Could not decode the recording; try again.");
    }
    const channels: Float32Array[] = [];
    for (let i = 0; i < decoded.numberOfChannels; i++) {
      channels.push(decoded.getChannelData(i));
    }
    const wav = encodeWavFromChannels(channels, decoded.sampleRate);
    // Base64 in chunks to avoid call-stack issues on long recordings.
    let base64 = "";
    const view = new Uint8Array(wav);
    for (let i = 0; i < view.length; i += 0x8000) {
      base64 += String.fromCharCode(...view.subarray(i, i + 0x8000));
    }
    return { wavBase64: btoa(base64), byteLength: view.length, seconds };
  }, [teardown]);

  return { recording, error, start, stop };
}