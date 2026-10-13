import { invoke, isTauri } from "@tauri-apps/api/core";
export const desktop = isTauri();
let layoutQueue: Promise<unknown> = Promise.resolve();
export async function call<T>(name: string, args: unknown = {}): Promise<T> {
  if (!desktop)
    throw new Error("当前为界面预览。请通过 npm run desktop 启动桌面应用。");
  return invoke<T>("tool_call", { name, args });
}
export async function layout(visible: boolean, bounds?: number[]) {
  if (!desktop) return;
  // Navigation, dialogs and ResizeObserver can update the native area together.
  // Finish each IPC request before sending the next desired state so an older
  // hide request cannot complete after a newer show request.
  const request = layoutQueue.then(() =>
    invoke("workspace_layout", { visible, bounds: bounds ?? null }),
  );
  layoutQueue = request.catch(() => {});
  await request;
}
