import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

/**
 * Saves a full-page shot of the owner's page when `SHOTS_DIR` names
 * a folder (the handover's shots); otherwise does nothing. Shots hold what
 * the page shows, never its address, so no owner's link token is kept; a
 * shot of PayPal's own window holds no login (the buyer is signed in by
 * then and PayPal shows only a name).
 *
 * @param page - The page.
 * @param name - The shot's name, without its extension.
 */
export async function saveShot(page: Page, name: string): Promise<void> {
  const folder = process.env.SHOTS_DIR;
  if (!folder) {
    return;
  }
  mkdirSync(folder, { recursive: true });
  const width = page.viewportSize()?.width ?? 390;
  await page.screenshot({ path: join(folder, `${name}-${width}.png`), fullPage: true });
}
