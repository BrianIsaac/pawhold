import type { ReactNode } from "react";

import type { OwnerCaseHeader } from "@/owner/view";
import { patientDrawn } from "@/owner/wording";
import { withSpecies } from "@/practice/species";

import { Animal } from "../../../components/Drawing";
import styles from "./page.module.css";

/**
 * The head of an owner's page (the restyle's mock-ups): a mint panel with the
 * animal drawn by its species (U17), its name and species set large in the
 * display face, then the page's own heading and words.
 *
 * @param props - The case's header and the page's heading.
 * @param props.header - The case, as the owner's page reads it.
 * @param props.children - The page's heading and the words under it.
 * @returns The head.
 */
export function OwnerHead({
  header,
  children,
}: {
  readonly header: OwnerCaseHeader;
  readonly children: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <Animal
        species={header.species}
        label={patientDrawn(header.patientName, header.species)}
        className={styles.pet}
      />
      <p className={styles.name}>{withSpecies(header.patientName, header.species)}</p>
      {children}
    </header>
  );
}
