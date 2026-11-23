import { invoke } from "@tauri-apps/api/core";

export async function saveBlob(blob: Blob, name: string): Promise<boolean> {
  if (window.electron.getPlatform() === "android") {
    const reader = new FileReader();
    const data = await new Promise<string>((resolve, reject) => {
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
      reader.readAsDataURL(blob);
    });
    return invoke("android_export_file", { name, mime: blob.type, data });
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
