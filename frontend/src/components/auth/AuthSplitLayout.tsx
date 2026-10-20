import type { ReactNode } from "react";
import { AsciiStackArtwork } from "./AsciiStackArtwork";
import styles from "./AuthSplitLayout.module.css";

function StackMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={styles.brandMark}>
      <path d="m3 11 13-7 13 7-13 7-13-7Zm0 5 13 7 13-7M3 21l13 7 13-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AuthSplitLayout({ children, headingId, registration = false }: {
  children: ReactNode;
  headingId: string;
  registration?: boolean;
}) {
  return (
    <main className={styles.page}>
      <aside className={styles.visual} aria-label="About StackPilot">
        <AsciiStackArtwork />
      </aside>
      <section className={`${styles.formPanel}${registration ? ` ${styles.registration}` : ""}`} aria-labelledby={headingId}>
        <div className={styles.formContent}>
          <div className={styles.mobileBrand}><StackMark />StackPilot</div>
          {children}
        </div>
        <p className={styles.formFooter}>Your workspace. Your infrastructure. Your way.</p>
      </section>
    </main>
  );
}
