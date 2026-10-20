import styles from "@/components/auth/AuthSplitLayout.module.css";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={styles.authRoot}>
      {children}
    </div>
  );
}
