/*
 * The Scheduler's core, as the browser loads it (U8b). Bryntum's React
 * wrapper imports `@bryntum/scheduler`; next.config.ts answers that import
 * with this file, which loads the package's own module from the day's route
 * (`scheduler/route.ts`) and hands on the four names the wrapper asks for.
 * The trial's module is obfuscated, and Turbopack runs out of memory
 * bundling it (10 GB and more, measured 13 October 2026), so the bundler
 * never sees it. A failed load rejects here, and the day stays on the plain
 * timeline.
 */

import type * as SchedulerCore from "@bryntum/scheduler";

/** Where the browser finds the Scheduler's module. */
export const SCHEDULER_MODULE_PATH = "/day/scheduler";

const address: string = SCHEDULER_MODULE_PATH;
const core = (await import(/* webpackIgnore: true */ address)) as typeof SchedulerCore;

export const { DomHelper, Scheduler, StringHelper, Widget } = core;
