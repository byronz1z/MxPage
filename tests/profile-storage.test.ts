import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareAvatar, saveProfile } from "../components/settings/profile-store";
import { defaultProfile, PROFILE_STORAGE_KEY, readProfile } from "../lib/profile";

test("profile save persists validated data and surfaces storage failures", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    setItem(key: string, value: string) { storage.set(key, value); },
  } });
  try {
    const draft = { ...defaultProfile, name: "新名字", username: "new_name" };
    saveProfile(draft);
    assert.deepEqual(readProfile(storage.get(PROFILE_STORAGE_KEY)!), draft);
    assert.throws(() => saveProfile({ ...draft, name: " " }));
    assert.deepEqual(readProfile(storage.get(PROFILE_STORAGE_KEY)!), draft);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem() { throw new Error("quota exceeded"); } } });
    assert.throws(() => saveProfile(defaultProfile), /quota exceeded/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("avatars reject unsupported and oversized files before decoding", async () => {
  await assert.rejects(prepareAvatar(new File(["<svg/>"], "avatar.svg", { type: "image/svg+xml" })), /PNG/);
  await assert.rejects(prepareAvatar(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })), /5 MB/);
});

test("avatar processing crops a wide image centrally, bounds output and releases decoded pixels", async () => {
  const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  let released = 0;
  let dimensions: number[] = [];
  const bitmap = { width: 800, height: 400, close() { released++; } };
  const canvas = { width: 0, height: 0,
    getContext() { return { drawImage(_source: unknown, ...args: number[]) { dimensions = args; } }; },
    toDataURL() { return "data:image/webp;base64,YQ=="; },
  };
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: async () => bitmap });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement() { return canvas; } } });
  try {
    assert.equal(await prepareAvatar(new File(["sample"], "avatar.png", { type: "image/png" })), "data:image/webp;base64,YQ==");
    assert.deepEqual(dimensions, [200, 0, 400, 400, 0, 0, 256, 256]);
    assert.equal(canvas.width, 256); assert.equal(canvas.height, 256); assert.equal(released, 1);
    bitmap.width = 100_000;
    bitmap.height = 100_000;
    await assert.rejects(prepareAvatar(new File(["sample"], "avatar.png", { type: "image/png" })), /尺寸过大/);
    assert.equal(released, 2);
  } finally {
    for (const [key, descriptor] of [["createImageBitmap", bitmapDescriptor], ["document", documentDescriptor]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
