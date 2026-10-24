import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DLQ-Healer Dashboard",
  description: "AI-Assisted Queue Failure Recovery Platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
