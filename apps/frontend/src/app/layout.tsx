import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { SidebarProvider } from "@/context/SidebarContext";

const inter = Inter({ 
  subsets: ["latin"],
  variable: "--font-inter"
});

const jetbrainsMono = JetBrains_Mono({ 
  subsets: ["latin"],
  variable: "--font-jetbrains-mono"
});

const spaceGrotesk = Space_Grotesk({ 
  subsets: ["latin"],
  variable: "--font-space-grotesk"
});

export const metadata: Metadata = {
  title: "Nexus Control",
  description: "Monitoring 14 autonomous instances across 3 clusters",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className={`${inter.variable} ${jetbrainsMono.variable} ${spaceGrotesk.variable} antialiased`}>
        <SidebarProvider>
          {children}
        </SidebarProvider>
        <div
          className="fixed inset-0 pointer-events-none opacity-[0.03] z-[-1]"
          style={{
            backgroundImage: "radial-gradient(#adc6ff 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        />
      </body>
    </html>
  );
}