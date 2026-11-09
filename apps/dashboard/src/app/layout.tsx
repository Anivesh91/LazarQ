import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LazarQ | Autonomous Recovery Cockpit",
  description:
    "Self-hosted AI-Assisted Dead Letter Queue Failure Recovery Platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 antialiased min-h-screen selection:bg-cyan-500/20 selection:text-cyan-200">
        {children}
      </body>
    </html>
  );
}
