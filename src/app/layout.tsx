import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Robinhood Chain Liquidity Terminal",
  description:
    "Canonical Robinhood Stock Token registry for Robinhood Chain.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
