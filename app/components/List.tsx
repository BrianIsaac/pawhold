import { Children, type CSSProperties, type ReactNode } from "react";

import { EmptyState } from "./EmptyState";
import styles from "./List.module.css";

/** A list's props. */
export interface ListProps {
  /** What the list is, for assistive technology. */
  readonly label: string;
  /** The column headings, shown once above the rows on a wide screen. */
  readonly columns: readonly string[];
  /** The grid's column widths on a wide screen; equal shares by default. */
  readonly template?: string;
  /** Shown instead of the list when it has no rows. */
  readonly empty?: ReactNode;
  /** A drawing above the empty words. */
  readonly emptyFigure?: ReactNode;
  readonly children: ReactNode;
}

/**
 * Rows of cells under column headings. On a wide screen it reads as a
 * table; on a phone each row stacks its cells with their column's name.
 * Each cell names its own column, so the shared headings are hidden from
 * assistive technology and a row reads whole ("Patient Biscuit, Money Held").
 *
 * @param props - The label, the columns, the template, the empty words, their drawing and the rows.
 * @returns The list.
 */
export function List({ label, columns, template, empty, emptyFigure, children }: ListProps) {
  const rows = Children.toArray(children);
  const style = {
    "--list-columns": template ?? `repeat(${columns.length}, minmax(0, 1fr))`,
  } as CSSProperties;
  return (
    <div className={styles.list} style={style}>
      <div className={styles.headings} aria-hidden="true">
        {columns.map((column) => (
          <span key={column}>{column}</span>
        ))}
      </div>
      {rows.length === 0 && empty !== undefined ? (
        emptyFigure ? (
          <EmptyState figure={emptyFigure}>{empty}</EmptyState>
        ) : (
          <p className={styles.empty}>{empty}</p>
        )
      ) : (
        <ul aria-label={label} className={styles.rows}>
          {rows}
        </ul>
      )}
    </div>
  );
}

/** One cell of a row: its column's name and what it holds. */
export interface ListCell {
  readonly column: string;
  readonly content: ReactNode;
}

/** A row's props. */
export interface ListRowProps {
  readonly cells: readonly ListCell[];
}

/**
 * One row of a {@link List}.
 *
 * @param props - The row's cells, in the list's column order.
 * @returns The row.
 */
export function ListRow({ cells }: ListRowProps) {
  return (
    <li className={styles.row}>
      {cells.map((cell) => (
        <div key={cell.column} className={styles.cell}>
          <span className={styles.cellLabel}>{cell.column}</span>
          <div className={styles.cellContent}>{cell.content}</div>
        </div>
      ))}
    </li>
  );
}
