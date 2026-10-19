import type { TranslationSubmission } from "./client-queue";

export type UploadDraft = { input: TranslationSubmission; projects: Array<{ id: string; uploaded: number }> };
export type UploadDraftStore = {
  get(id: string): Promise<UploadDraft | undefined>;
  put(id: string, draft: UploadDraft): Promise<void>;
  remove(id: string): Promise<void>;
};

// v1 drafts remain readable. v2 keeps immutable Files separate from small checkpoints.
async function transaction<T>(work: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("mxpage-translation-uploads", 2);
    let blocked = false;
    open.onupgradeneeded = () => {
      for (const name of ["drafts", "inputs", "checkpoints"]) if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
    };
    open.onblocked = () => { blocked = true; reject(new Error("请关闭仍在使用旧版上传草稿的标签页后重试。")); };
    open.onsuccess = () => { if (blocked) { open.result.close(); return; } open.result.onversionchange = () => open.result.close(); resolve(open.result); };
    open.onerror = () => reject(open.error);
  });
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["drafts", "inputs", "checkpoints"], "readwrite");
    let value: T;
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error("无法保存上传进度")); };
    try { work(tx, result => { value = result; }); } catch (error) { tx.abort(); db.close(); reject(error); }
  });
}
export const uploadDrafts: UploadDraftStore = {
  get: id => transaction<UploadDraft | undefined>((tx, result) => {
    const inputs = tx.objectStore("inputs"), checkpoints = tx.objectStore("checkpoints"), legacy = tx.objectStore("drafts");
    const input = inputs.get(id);
    input.onsuccess = () => {
      if (input.result) {
        const checkpoint = checkpoints.get(id);
        checkpoint.onsuccess = () => result({ input: input.result, projects: checkpoint.result || [] });
      } else {
        const previous = legacy.get(id);
        previous.onsuccess = () => {
          const draft = previous.result as UploadDraft | undefined;
          if (draft) { inputs.add(draft.input, id); checkpoints.put(draft.projects, id); legacy.delete(id); }
          result(draft);
        };
      }
    };
  }),
  put: (id, draft) => transaction<void>(tx => {
    const inputs = tx.objectStore("inputs");
    // count() reads only existence, not the entire File[] on every retry/checkpoint.
    const exists = inputs.count(id);
    exists.onsuccess = () => { if (!exists.result) inputs.add(draft.input, id); };
    tx.objectStore("checkpoints").put(draft.projects, id);
  }),
  remove: id => transaction<void>(tx => { for (const name of ["drafts", "inputs", "checkpoints"]) tx.objectStore(name).delete(id); }),
};
