export const backupFormat = "biubiu-desktop";
export function isDesktopBackup(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "format" in value &&
    value.format === backupFormat &&
    "version" in value &&
    value.version === 1
  );
}
export const maxBackupBytes = 8 * 1024 * 1024;
export const backupNamePattern = /^biubiu-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[a-f0-9]{8}\.json$/;
export interface BackupTarget {
  id: string;
  name: string;
}
