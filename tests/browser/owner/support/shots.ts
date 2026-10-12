import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

/**
 * Saves a full-page shot of the owner's page when `PAWHOLD_SHOTS_DIR` names
 * a folder (the handover's shots); otherwise does nothing. Shots hold what
 * the page shows, never its address, so no owner's link token is kept.
 *
 * @param page - The page.
 * @param name - The shot's name, without its extension.
 */
export async function saveShot(page: Page, name: string): Promise<void> {
  const folder = process.env.PAWHOLD_SHOTS_DIR;
  if (!folder) {
    return;
  }
  mkdirSync(folder, { recursive: true });
  // `next dev` draws its indicator over the page; it is not the page.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({ path: join(folder, `${name}-390.png`), fullPage: true });
}
