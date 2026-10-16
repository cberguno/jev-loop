import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "voice-session",
  description:
    "Text-and-voice chat streaming microphone audio to an OpenRouter audio-capable model with live transcripts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}