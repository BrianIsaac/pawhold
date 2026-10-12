/** The Postgres error a refused statement raised. */
export interface PostgresRefusal {
  readonly code: string | undefined;
  readonly message: string;
}

/**
 * Runs a statement expected to be refused and returns the Postgres error it
 * raised, through Drizzle's wrapping of the driver's error.
 *
 * @param statement - The statement.
 * @returns The SQLSTATE code and the message.
 * @throws Error when the statement succeeds.
 */
export async function refusalOf(statement: PromiseLike<unknown>): Promise<PostgresRefusal> {
  try {
    await statement;
  } catch (error) {
    const raised = (error as { cause?: unknown }).cause ?? error;
    const { code, message } = raised as { code?: string; message?: string };
    return { code, message: message ?? "" };
  }
  throw new Error("the statement was not refused");
}
