import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "pawhold",
  description:
    "Hold-then-capture estimates for independent vet practices, on PayPal. Sandbox only.",
};

/**
 * The root layout every page renders inside.
 *
 * @param props - The page tree to render.
 * @param props.children - The page.
 * @returns The document shell.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
