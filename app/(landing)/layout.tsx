import type { ReactNode } from "react";

import { fraunces } from "../fonts";

/**
 * The landing page's layout: it carries Fraunces for the page's heading, so
 * the face is preloaded here and on the owner's pages only.
 *
 * @param props - The page.
 * @param props.children - The page.
 * @returns The page, with the display face's variable set.
 */
export default function LandingLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <div className={fraunces.variable}>{children}</div>;
}
