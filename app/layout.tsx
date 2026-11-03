import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "ClipForge — AI Shorts Studio", description: "Find the best moments in your videos and turn them into Shorts locally in your browser." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
